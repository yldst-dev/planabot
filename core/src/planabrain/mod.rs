use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::io::AsyncWriteExt;

pub(crate) mod server;
use tokio::process::Command as TokioCommand;

#[derive(Debug, Deserialize)]
struct LocalMemoryResetOutput {
    removed: bool,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TodoListOutput {
    pub items: Vec<serde_json::Value>,
    pub markdown: String,
    pub context: String,
}

#[derive(Debug, Deserialize)]
pub(crate) struct TodoInterpretOutput {
    pub handled: bool,
    pub message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleInterpretOutput {
    pub handled: bool,
    pub action: String,
    pub kind: Option<String>,
    pub title: Option<String>,
    pub due_at_ms: Option<i64>,
    pub duration_ms: Option<i64>,
    pub target: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct ImageInput {
    pub path: PathBuf,
    pub mime_type: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum PlanabrainErrorKind {
    CreditExhausted,
    AuthFailed,
    RateLimited,
    ProviderUnavailable,
    NetworkTimeout,
    InvalidRequest,
    EmptyOrFiltered,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
pub(crate) struct PlanabrainError {
    pub kind: PlanabrainErrorKind,
    #[serde(default)]
    pub provider: Option<String>,
    #[serde(default)]
    pub status: Option<u16>,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub retryable: bool,
}

impl std::fmt::Display for PlanabrainError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "planabrain 오류[{:?}]", self.kind)?;
        if let Some(provider) = self.provider.as_deref() {
            write!(f, " provider={provider}")?;
        }
        if let Some(status) = self.status {
            write!(f, " status={status}")?;
        }
        write!(f, " retryable={}: {}", self.retryable, self.message)
    }
}

impl std::error::Error for PlanabrainError {}

const PLANABRAIN_ERROR_JSON_PREFIX: &str = "PLANABRAIN_ERROR_JSON:";
const PLANABRAIN_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
const PLANABRAIN_ASK_TIMEOUT: Duration = Duration::from_secs(200);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnPrepareInput {
    pub user_id: String,
    pub chat_scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub conversation_id: Option<String>,
    pub question: String,
    pub memory_query_text: String,
    pub now_ms: i64,
    pub memory_enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<u32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskRequest<'a> {
    user_id: &'a str,
    question: &'a str,
    current_turn_text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    memory_context: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image: Option<AskImage>,
    memory_enabled: bool,
    #[serde(skip_serializing_if = "<[serde_json::Value]>::is_empty")]
    recent_turns: &'a [serde_json::Value],
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AskTranscript {
    #[serde(default)]
    pub wire_messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub epoch: u32,
}

#[derive(Debug)]
pub(crate) struct AskOutcome {
    pub answer: String,
    pub transcript: Option<AskTranscript>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AskImage {
    path: String,
    mime_type: String,
}

#[derive(Debug, Deserialize)]
struct AskResponse {
    answer: String,
    #[serde(default)]
    transcript: Option<AskTranscript>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExchangeRequest<'a> {
    user_id: &'a str,
    chat_scope: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    conversation_id: Option<&'a str>,
    user_text: &'a str,
    assistant_text: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    wire_messages: Option<&'a [serde_json::Value]>,
    #[serde(skip_serializing_if = "Option::is_none")]
    epoch: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct ExchangeResponse {
    ok: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TurnPrepareOutput {
    #[serde(default)]
    pub todo: Option<TodoInterpretOutput>,
    #[serde(default)]
    pub schedule: Option<ScheduleInterpretOutput>,
    #[serde(default)]
    pub todo_list: Option<TodoListOutput>,
    #[serde(default)]
    pub memory_context: Option<String>,
    #[serde(default)]
    pub recent_turns: Vec<serde_json::Value>,
    #[serde(default)]
    pub errors: HashMap<String, String>,
}

pub(crate) async fn prepare_turn(input: &TurnPrepareInput) -> Result<TurnPrepareOutput> {
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }
    if let Some(output) = server::post_json::<_, TurnPrepareOutput>(
        "/v1/turn-prepare",
        input,
        PLANABRAIN_COMMAND_TIMEOUT,
    )
    .await?
    {
        return Ok(output);
    }
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let mut command = build_planabrain_command(&root)?;
    command.current_dir(&root).arg("turn-prepare");
    apply_dotenv_path(&mut command, &root);
    let payload = serde_json::to_vec(input).context("turn-prepare 입력 직렬화 실패")?;
    let output = run_planabrain_output(
        command,
        Some(payload),
        PLANABRAIN_COMMAND_TIMEOUT,
        "turn-prepare",
    )
    .await?;
    let stdout = success_stdout(output, "turn-prepare")?;
    serde_json::from_str(stdout.trim()).context("turn-prepare 결과 파싱 실패")
}

pub(crate) async fn run_planabrain_output(
    command: ProcessCommand,
    stdin_payload: Option<Vec<u8>>,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output> {
    let mut command = TokioCommand::from(command);
    command
        .kill_on_drop(true)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let run = async {
        let mut child = command
            .spawn()
            .with_context(|| format!("planabrain {label} 실행 실패"))?;
        if let Some((payload, mut stdin)) = stdin_payload.zip(child.stdin.take()) {
            stdin
                .write_all(&payload)
                .await
                .with_context(|| format!("planabrain {label} 입력 전달 실패"))?;
            let _ = stdin.shutdown().await;
        }
        child
            .wait_with_output()
            .await
            .with_context(|| format!("planabrain {label} 실행 실패"))
    };
    match tokio::time::timeout(timeout, run).await {
        Ok(result) => result,
        Err(_) => Err(anyhow!(
            "planabrain {label} 시간 초과 ({}초)",
            timeout.as_secs()
        )),
    }
}

fn success_stdout(output: std::process::Output, label: &str) -> Result<String> {
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(mut structured) = parse_planabrain_error(&stderr) {
            if structured.message.trim().is_empty() {
                structured.message = stderr_without_error_json(&stderr);
            }
            return Err(anyhow::Error::new(structured));
        }
        return Err(anyhow!("planabrain {label} 오류: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn apply_dotenv_path(command: &mut ProcessCommand, root: &Path) {
    let repo_root = root.parent().unwrap_or(root);
    let dotenv_path = repo_root.join(".env");
    if dotenv_path.exists() {
        command.env("DOTENV_CONFIG_PATH", dotenv_path);
    }
}

fn parse_planabrain_error(stderr: &str) -> Option<PlanabrainError> {
    let json = stderr
        .lines()
        .rev()
        .find_map(|line| line.trim().strip_prefix(PLANABRAIN_ERROR_JSON_PREFIX))?;
    serde_json::from_str::<PlanabrainError>(json.trim()).ok()
}

fn stderr_without_error_json(stderr: &str) -> String {
    stderr
        .lines()
        .filter(|line| !line.trim().starts_with(PLANABRAIN_ERROR_JSON_PREFIX))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

pub(crate) fn extract_plana_question(text: &str) -> Option<String> {
    let trimmed = text.trim_start();
    let prefixes = ["프라나야"];

    for prefix in prefixes {
        if let Some(rest) = trimmed.strip_prefix(prefix) {
            let question = rest
                .trim_start_matches(|c: char| c.is_whitespace() || matches!(c, ':' | '-' | '—'))
                .trim();
            return Some(question.to_string());
        }
    }

    None
}

pub(crate) async fn run_planabrain_ask(
    question: &str,
    current_turn_text: &str,
    memory_context: Option<&str>,
    user_id: &str,
    image_input: Option<ImageInput>,
    recent_turns: &[serde_json::Value],
) -> Result<AskOutcome> {
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }

    let request = AskRequest {
        user_id,
        question,
        current_turn_text,
        memory_context,
        image: image_input.as_ref().map(|image| AskImage {
            path: absolute_path(&image.path).to_string_lossy().into_owned(),
            mime_type: image.mime_type.clone(),
        }),
        memory_enabled: !is_local_memory_enabled(),
        recent_turns,
    };
    let served =
        server::post_json::<_, AskResponse>("/v1/ask", &request, PLANABRAIN_ASK_TIMEOUT).await;
    match served {
        Ok(Some(response)) => {
            if let Some(image) = image_input.as_ref() {
                let _ = std::fs::remove_file(&image.path);
            }
            return Ok(AskOutcome {
                answer: response.answer,
                transcript: response.transcript,
            });
        }
        Ok(None) => {}
        Err(err) => {
            if let Some(image) = image_input.as_ref() {
                let _ = std::fs::remove_file(&image.path);
            }
            return Err(err);
        }
    }

    let mut prepared = prepare_planabrain_ask(
        question,
        current_turn_text,
        memory_context,
        user_id,
        image_input,
        recent_turns,
    )?;
    let command = prepared
        .command
        .take()
        .context("planabrain 실행 명령이 없습니다")?;
    let output = run_planabrain_output(command, None, PLANABRAIN_ASK_TIMEOUT, "ask").await?;
    Ok(AskOutcome {
        answer: success_stdout(output, "ask")?,
        transcript: None,
    })
}

fn absolute_path(path: &Path) -> PathBuf {
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    }
}

pub(crate) async fn remember_planabrain_exchange(
    current_turn_text: &str,
    answer: &str,
    user_id: &str,
    chat_id: i64,
    conversation_scope_id: Option<&str>,
    transcript: Option<&AskTranscript>,
) -> Result<()> {
    if !is_local_memory_enabled() {
        return Ok(());
    }

    let chat_scope = format!("chat_{chat_id}");
    let request = ExchangeRequest {
        user_id,
        chat_scope: &chat_scope,
        conversation_id: conversation_scope_id,
        user_text: current_turn_text,
        assistant_text: answer,
        wire_messages: transcript
            .map(|value| value.wire_messages.as_slice())
            .filter(|messages| !messages.is_empty()),
        epoch: transcript.map(|value| value.epoch),
    };
    if let Some(response) = server::post_json::<_, ExchangeResponse>(
        "/v1/memory-exchange",
        &request,
        PLANABRAIN_COMMAND_TIMEOUT,
    )
    .await?
    {
        if response.ok {
            return Ok(());
        }
        return Err(anyhow!("planabrain 서버가 메모리 교환을 거부했습니다"));
    }

    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let (command, temp_files) = build_memory_exchange_command(
        &root,
        current_turn_text,
        answer,
        user_id,
        &chat_scope,
        conversation_scope_id,
    )?;
    let result =
        run_planabrain_output(command, None, PLANABRAIN_COMMAND_TIMEOUT, "memory-exchange").await;
    for path in temp_files {
        let _ = std::fs::remove_file(path);
    }
    success_stdout(result?, "memory-exchange")?;
    Ok(())
}

pub(crate) async fn reset_user_memory(user_id: &str) -> Result<bool> {
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }

    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let memory_file = planabrain_memory_file(&root, user_id)?;

    let removed_planabrain = match tokio::fs::remove_file(&memory_file).await {
        Ok(()) => true,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => false,
        Err(err) => return Err(err.into()),
    };

    let removed_local = run_planabrain_memory_reset_user(&root, user_id).await?;

    Ok(removed_planabrain || removed_local.removed)
}

pub(crate) async fn interpret_schedule_request(text: &str) -> Result<ScheduleInterpretOutput> {
    const MAX_CLI_TEXT_CHARS: usize = 2000;
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }

    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let mut command = build_planabrain_command(&root)?;
    command
        .current_dir(&root)
        .arg("schedule-interpret")
        .env("PLANABRAIN_NOW_MS", crate::schedule::now_ms().to_string());
    apply_dotenv_path(&mut command, &root);

    let mut text_file = None;
    if text.chars().count() > MAX_CLI_TEXT_CHARS {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("planabrain_schedule_text_{timestamp}.txt"));
        std::fs::write(&path, text).context("planabrain 텍스트 파일 저장 실패")?;
        command.env("PLANABRAIN_SCHEDULE_TEXT_FILE", &path);
        text_file = Some(path);
    } else {
        command.arg(text);
    }

    let result = run_planabrain_output(
        command,
        None,
        PLANABRAIN_COMMAND_TIMEOUT,
        "schedule-interpret",
    )
    .await;
    if let Some(path) = text_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    let stdout = success_stdout(result?, "schedule-interpret")?;
    serde_json::from_str(stdout.trim()).context("schedule-interpret 결과 파싱 실패")
}

pub(crate) async fn list_user_todos(user_id: &str) -> Result<TodoListOutput> {
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }

    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let stdout = run_planabrain_simple_command(&root, &["todo-list", user_id]).await?;
    serde_json::from_str(stdout.trim()).context("todo-list 결과 파싱 실패")
}

pub(crate) fn is_planabrain_allowed(chat_id: i64, user_id: Option<i64>, is_private: bool) -> bool {
    if !is_planabrain_enabled() {
        return false;
    }

    if ALLOWED_CHAT_IDS.contains(&chat_id) {
        return true;
    }
    if !is_private {
        return false;
    }
    let Some(user_id) = user_id else {
        return false;
    };
    ALLOWED_USER_IDS.contains(&user_id)
}

pub(crate) fn truncate_message(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_string();
    }
    if limit == 0 {
        return String::new();
    }

    if let Some(source_start) = source_suffix_start(text) {
        let source = text[source_start..].trim();
        let separator = "…\n\n";
        let source_len = source.chars().count();
        let separator_len = separator.chars().count();
        if source_len + separator_len < limit {
            let body_limit = limit - source_len - separator_len;
            let body = take_chars(text[..source_start].trim_end(), body_limit);
            return format!("{body}{separator}{source}");
        }
    }

    let mut out = take_chars(text, limit.saturating_sub(1));
    out.push('…');
    out
}

pub(crate) fn find_planabrain_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let candidates = [cwd.join("planabrain"), cwd.join("..").join("planabrain")];
    candidates
        .into_iter()
        .find(|candidate| candidate.join("package.json").exists())
}

fn planabrain_memory_file(planabrain_root: &Path, user_id: &str) -> Result<PathBuf> {
    let memory_dir = resolve_planabrain_memory_dir(planabrain_root)?;
    let safe_id = safe_user_id(user_id);
    Ok(memory_dir.join(format!("{safe_id}.json")))
}

fn resolve_planabrain_memory_dir(planabrain_root: &Path) -> Result<PathBuf> {
    let data_root = planabrain_data_root(planabrain_root);
    let explicit_memory_dir = std::env::var("PLANABRAIN_MEMORY_DIR")
        .ok()
        .filter(|raw| !raw.trim().is_empty());
    if let Some(raw) = explicit_memory_dir {
        return Ok(resolve_relative(&data_root, raw.trim()));
    }

    let index_path = std::env::var("PLANABRAIN_INDEX_PATH")
        .unwrap_or_else(|_| ".planabrain/index.json".to_string());
    let index_path = resolve_relative(&data_root, &index_path);
    let base = index_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| data_root.clone());
    Ok(base.join("memory"))
}

fn planabrain_data_root(planabrain_root: &Path) -> PathBuf {
    let explicit = std::env::var("PLANABRAIN_DATA_DIR").ok();
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    data_root_from(explicit.as_deref(), &cwd, planabrain_root)
}

fn data_root_from(explicit: Option<&str>, cwd: &Path, planabrain_root: &Path) -> PathBuf {
    match explicit.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => resolve_relative(cwd, value),
        None => planabrain_root
            .parent()
            .map(Path::to_path_buf)
            .unwrap_or_else(|| planabrain_root.to_path_buf()),
    }
}

fn resolve_relative(base: &Path, raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        base.join(path)
    }
}

fn safe_user_id(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return "default".to_string();
    }

    let mut out = String::new();
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' || ch == '-' {
            out.push(ch);
        } else {
            out.push('_');
        }
        if out.len() >= 200 {
            break;
        }
    }

    if out.is_empty() {
        "default".to_string()
    } else {
        out
    }
}

static PLANABRAIN_ENABLED: Lazy<bool> = Lazy::new(|| {
    let Ok(raw) = std::env::var("PLANABRAIN_ENABLED") else {
        return true;
    };

    let normalized = raw.trim().to_ascii_lowercase();
    !(normalized.is_empty()
        || normalized == "0"
        || normalized == "false"
        || normalized == "off"
        || normalized == "no")
});

pub(crate) fn is_planabrain_enabled() -> bool {
    *PLANABRAIN_ENABLED
}

static ALLOWED_CHAT_IDS: Lazy<HashSet<i64>> = Lazy::new(|| {
    let raw = std::env::var("PLANABRAIN_ALLOWED_CHAT_IDS").unwrap_or_default();
    raw.split(|ch: char| ch == ',' || ch == ';' || ch.is_whitespace())
        .filter_map(|item| {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                None
            } else {
                trimmed.parse::<i64>().ok()
            }
        })
        .collect()
});

static ALLOWED_USER_IDS: Lazy<HashSet<i64>> = Lazy::new(|| {
    let raw = std::env::var("PLANABRAIN_ALLOWED_USER_IDS").unwrap_or_default();
    raw.split(|ch: char| ch == ',' || ch == ';' || ch.is_whitespace())
        .filter_map(|item| {
            let trimmed = item.trim();
            if trimmed.is_empty() {
                None
            } else {
                trimmed.parse::<i64>().ok()
            }
        })
        .collect()
});

struct PreparedPlanabrainAsk {
    command: Option<ProcessCommand>,
    question_file: Option<PathBuf>,
    image_file: Option<PathBuf>,
    recent_turns_file: Option<PathBuf>,
}

impl Drop for PreparedPlanabrainAsk {
    fn drop(&mut self) {
        for path in [
            self.question_file.as_ref(),
            self.image_file.as_ref(),
            self.recent_turns_file.as_ref(),
        ]
        .into_iter()
        .flatten()
        {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn prepare_planabrain_ask(
    question: &str,
    current_turn_text: &str,
    memory_context: Option<&str>,
    user_id: &str,
    image_input: Option<ImageInput>,
    recent_turns: &[serde_json::Value],
) -> Result<PreparedPlanabrainAsk> {
    const MAX_CLI_QUESTION_CHARS: usize = 2000;
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;

    let mut command = build_planabrain_command(&root)?;
    apply_dotenv_path(&mut command, &root);

    let mut question_file = None;
    command
        .current_dir(&root)
        .env("PLANABRAIN_USER_ID", user_id)
        .env("PLANABRAIN_CURRENT_TURN_TEXT", current_turn_text)
        .env_remove("PLANABRAIN_MEMORY_CONTEXT");
    if let Some(memory_context) = memory_context {
        command.env("PLANABRAIN_MEMORY_CONTEXT", memory_context);
    }
    if let Some(image_input) = image_input.as_ref() {
        let image_path = if image_input.path.is_absolute() {
            image_input.path.clone()
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(&image_input.path))
                .unwrap_or_else(|_| image_input.path.clone())
        };
        command
            .env("PLANABRAIN_IMAGE_FILE", image_path)
            .env("PLANABRAIN_IMAGE_MIME_TYPE", &image_input.mime_type);
    }
    if is_local_memory_enabled() {
        command.env("PLANABRAIN_MEMORY_ENABLED", "0");
    }
    let mut recent_turns_file = None;
    if !recent_turns.is_empty() {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!(
            "planabrain_recent_turns_{}_{timestamp}.json",
            std::process::id()
        ));
        std::fs::write(&path, serde_json::to_vec(recent_turns)?)
            .context("planabrain 최근 턴 파일 저장 실패")?;
        command.env("PLANABRAIN_RECENT_TURNS_FILE", &path);
        recent_turns_file = Some(path);
    }

    if question.chars().count() > MAX_CLI_QUESTION_CHARS {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("planabrain_question_{timestamp}.txt"));
        std::fs::write(&path, question).context("planabrain 질문 파일 저장 실패")?;
        command.env("PLANABRAIN_QUESTION_FILE", &path);
        question_file = Some(path);
        command.arg("ask");
    } else {
        command.arg("ask").arg(question);
    }

    Ok(PreparedPlanabrainAsk {
        command: Some(command),
        question_file,
        image_file: image_input.map(|input| input.path),
        recent_turns_file,
    })
}

pub(crate) fn build_planabrain_command(root: &Path) -> Result<ProcessCommand> {
    let dist_entry = root.join("dist/cli/index.js");
    let src_entry = root.join("src/cli/index.ts");
    let mut cmd = if dist_entry.exists() {
        let mut cmd = ProcessCommand::new("node");
        cmd.arg(dist_entry);
        cmd
    } else {
        let tsx_path = root.join("node_modules/.bin/tsx");
        if !tsx_path.exists() {
            return Err(anyhow!(
                "planabrain 실행 파일이 없습니다. dist 빌드 또는 tsx 설치가 필요합니다."
            ));
        }
        let mut cmd = ProcessCommand::new(tsx_path);
        cmd.arg(src_entry);
        cmd
    };
    cmd.env("PLANABRAIN_DATA_DIR", planabrain_data_root(root));
    Ok(cmd)
}

async fn run_planabrain_simple_command(root: &Path, args: &[&str]) -> Result<String> {
    let label = args.first().copied().unwrap_or("command");
    let mut command = build_planabrain_command(root)?;
    command.current_dir(root);
    for arg in args {
        command.arg(arg);
    }
    apply_dotenv_path(&mut command, root);
    let output = run_planabrain_output(command, None, PLANABRAIN_COMMAND_TIMEOUT, label).await?;
    success_stdout(output, label)
}

fn build_memory_exchange_command(
    planabrain_root: &Path,
    current_turn_text: &str,
    answer: &str,
    user_id: &str,
    chat_scope: &str,
    conversation_scope_id: Option<&str>,
) -> Result<(ProcessCommand, Vec<PathBuf>)> {
    const MAX_LOCAL_MEMORY_TEXT_CHARS: usize = 2000;
    let mut command = build_planabrain_command(planabrain_root)?;
    command
        .current_dir(planabrain_root)
        .arg("memory-exchange")
        .arg(user_id)
        .arg(chat_scope);
    if let Some(conversation_scope_id) = conversation_scope_id {
        command.env("PLANABRAIN_CONVERSATION_ID", conversation_scope_id);
    }

    let mut temp_files = Vec::new();
    if current_turn_text.chars().count() > MAX_LOCAL_MEMORY_TEXT_CHARS
        || answer.chars().count() > MAX_LOCAL_MEMORY_TEXT_CHARS
    {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let process_id = std::process::id();
        let user_path =
            std::env::temp_dir().join(format!("local_memory_user_{process_id}_{timestamp}.txt"));
        let assistant_path = std::env::temp_dir().join(format!(
            "local_memory_assistant_{process_id}_{timestamp}.txt"
        ));
        std::fs::write(&user_path, current_turn_text)
            .context("로컬 장기 메모리 사용자 질문 파일 저장 실패")?;
        if let Err(err) = std::fs::write(&assistant_path, answer) {
            let _ = std::fs::remove_file(&user_path);
            return Err(err).context("로컬 장기 메모리 응답 파일 저장 실패");
        }
        command
            .env("PLANABRAIN_LOCAL_MEMORY_USER_TEXT_FILE", &user_path)
            .env(
                "PLANABRAIN_LOCAL_MEMORY_ASSISTANT_TEXT_FILE",
                &assistant_path,
            );
        temp_files.push(user_path);
        temp_files.push(assistant_path);
    } else {
        command.arg(current_turn_text).arg(answer);
    }

    Ok((command, temp_files))
}

pub(crate) fn source_suffix_start(text: &str) -> Option<usize> {
    text.match_indices("출처:")
        .filter(|(index, _)| *index == 0 || text[..*index].ends_with('\n'))
        .map(|(index, _)| index)
        .last()
}

fn take_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

async fn run_planabrain_memory_reset_user(
    planabrain_root: &Path,
    user_id: &str,
) -> Result<LocalMemoryResetOutput> {
    let mut command = build_planabrain_command(planabrain_root)?;
    command
        .current_dir(planabrain_root)
        .arg("memory-reset-user")
        .arg(user_id);
    let output = run_planabrain_output(
        command,
        None,
        PLANABRAIN_COMMAND_TIMEOUT,
        "memory-reset-user",
    )
    .await?;
    let stdout = success_stdout(output, "memory-reset-user")?;
    serde_json::from_str(stdout.trim()).context("memory-reset-user 결과 파싱 실패")
}

pub(crate) fn is_local_memory_enabled() -> bool {
    let Ok(raw) = std::env::var("PLANABOT_LOCAL_MEMORY_ENABLED") else {
        return true;
    };

    let normalized = raw.trim().to_ascii_lowercase();
    !(normalized.is_empty() || normalized == "0" || normalized == "false")
}

pub(crate) fn resolve_local_memory_token_budget() -> Option<u32> {
    std::env::var("PLANABOT_LOCAL_MEMORY_TOKEN_BUDGET")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
}

#[cfg(test)]
mod tests {
    use super::{
        TurnPrepareInput, TurnPrepareOutput, data_root_from, prepare_turn, run_planabrain_output,
        truncate_message,
    };
    use std::path::{Path, PathBuf};
    use std::process::Command as ProcessCommand;
    use std::time::Duration;

    #[tokio::test]
    async fn run_planabrain_output_pipes_stdin_and_captures_stdout() {
        let mut command = ProcessCommand::new("sh");
        command.arg("-c").arg("cat");
        let output = run_planabrain_output(
            command,
            Some(b"hello turn".to_vec()),
            Duration::from_secs(5),
            "echo",
        )
        .await
        .expect("command succeeds");
        assert!(output.status.success());
        assert_eq!(String::from_utf8_lossy(&output.stdout), "hello turn");
    }

    #[tokio::test]
    async fn run_planabrain_output_times_out_and_kills_the_child() {
        let mut command = ProcessCommand::new("sh");
        command.arg("-c").arg("sleep 5; echo late");
        let started = std::time::Instant::now();
        let error = run_planabrain_output(command, None, Duration::from_millis(200), "sleep")
            .await
            .expect_err("timeout expected");
        assert!(error.to_string().contains("시간 초과"), "{error}");
        assert!(started.elapsed() < Duration::from_secs(3));
    }

    #[test]
    fn turn_prepare_output_parses_cli_contract() {
        let raw = r#"{"todo":{"handled":false,"action":"none","message":"","items":[]},"schedule":{"handled":true,"action":"add","kind":"timer","title":"요청하신 내용","dueAtMs":1788800600000,"durationMs":600000},"todoList":null,"memoryContext":null,"errors":{}}"#;
        let parsed: TurnPrepareOutput = serde_json::from_str(raw).expect("parse");
        assert!(
            !parsed
                .todo
                .as_ref()
                .map(|todo| todo.handled)
                .unwrap_or(true)
        );
        let schedule = parsed.schedule.expect("schedule");
        assert!(schedule.handled);
        assert_eq!(schedule.action, "add");
        assert_eq!(schedule.kind.as_deref(), Some("timer"));
        assert_eq!(schedule.duration_ms, Some(600_000));
        assert!(parsed.todo_list.is_none());
        assert!(parsed.memory_context.is_none());
        assert!(parsed.errors.is_empty());

        let with_errors: TurnPrepareOutput =
            serde_json::from_str(r#"{"errors":{"memory":"sqlite locked"}}"#).expect("parse");
        assert_eq!(
            with_errors.errors.get("memory").map(String::as_str),
            Some("sqlite locked")
        );
    }

    #[test]
    fn turn_prepare_input_serializes_camel_case_and_skips_empty_options() {
        let input = TurnPrepareInput {
            user_id: "u1".into(),
            chat_scope: "chat_1".into(),
            conversation_id: None,
            question: "q".into(),
            memory_query_text: "q".into(),
            now_ms: 5,
            memory_enabled: false,
            token_budget: None,
        };
        let json = serde_json::to_string(&input).expect("serialize");
        assert!(json.contains("\"userId\":\"u1\""));
        assert!(json.contains("\"chatScope\":\"chat_1\""));
        assert!(json.contains("\"nowMs\":5"));
        assert!(!json.contains("conversationId"));
        assert!(!json.contains("tokenBudget"));
    }

    #[tokio::test]
    #[ignore]
    async fn prepare_turn_runs_against_real_cli() {
        let input = TurnPrepareInput {
            user_id: "turn_test_user".into(),
            chat_scope: "chat_turn_test".into(),
            conversation_id: None,
            question: "10분 타이머 맞춰줘".into(),
            memory_query_text: "10분 타이머 맞춰줘".into(),
            now_ms: crate::schedule::now_ms(),
            memory_enabled: false,
            token_budget: None,
        };
        let prepared = prepare_turn(&input).await.expect("turn-prepare");
        eprintln!("prepared: {prepared:?}");
        assert!(
            prepared
                .schedule
                .map(|schedule| schedule.handled)
                .unwrap_or(false)
        );
    }

    #[test]
    fn data_root_defaults_to_parent_of_planabrain_root() {
        let root = Path::new("/app/planabrain");
        let cwd = Path::new("/somewhere");
        assert_eq!(data_root_from(None, cwd, root), PathBuf::from("/app"));
        assert_eq!(data_root_from(Some("  "), cwd, root), PathBuf::from("/app"));
    }

    #[test]
    fn data_root_honors_explicit_absolute_or_cwd_relative_value() {
        let root = Path::new("/app/planabrain");
        let cwd = Path::new("/srv");
        assert_eq!(
            data_root_from(Some("/var/planabot"), cwd, root),
            PathBuf::from("/var/planabot")
        );
        assert_eq!(
            data_root_from(Some("state"), cwd, root),
            PathBuf::from("/srv/state")
        );
    }

    #[test]
    fn truncate_message_keeps_text_within_limit() {
        let truncated = truncate_message("가나다라마바사", 5);

        assert_eq!(truncated, "가나다라…");
        assert_eq!(truncated.chars().count(), 5);
    }

    #[test]
    fn truncate_message_preserves_source_suffix() {
        let text = format!("{}\n\n출처: https://example.com", "본문".repeat(30));
        let truncated = truncate_message(&text, 35);

        assert!(truncated.ends_with("출처: https://example.com"));
        assert!(truncated.contains('…'));
        assert!(truncated.chars().count() <= 35);
    }

    #[test]
    fn truncate_message_handles_zero_limit() {
        assert_eq!(truncate_message("본문", 0), "");
    }
}
