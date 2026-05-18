use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use anyhow::{Context, Result, anyhow};
use log::warn;
use once_cell::sync::Lazy;
use serde::Deserialize;
use tokio::task;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocalMemoryPrepareOutput {
    memory_context: String,
}

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

#[derive(Debug, Clone)]
pub(crate) struct ImageInput {
    pub path: PathBuf,
    pub mime_type: String,
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
    user_id: &str,
    chat_id: i64,
    conversation_scope_id: Option<&str>,
    image_input: Option<ImageInput>,
) -> Result<String> {
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }

    let question = question.to_string();
    let user_id = user_id.to_string();
    let conversation_scope_id = conversation_scope_id.map(|value| value.to_string());
    let image_input = image_input.clone();

    let handle = task::spawn_blocking(move || {
        run_planabrain_ask_blocking(
            &question,
            &user_id,
            chat_id,
            conversation_scope_id.as_deref(),
            image_input,
        )
    });
    handle
        .await
        .context("planabrain 실행 작업이 중단되었습니다")?
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

    let root = root.clone();
    let user_id = user_id.to_string();
    let removed_local =
        task::spawn_blocking(move || run_planabrain_memory_reset_user(&root, &user_id))
            .await
            .context("로컬 장기 메모리 정리 작업이 중단되었습니다")??;

    Ok(removed_planabrain || removed_local.removed)
}

pub(crate) async fn list_user_todos(user_id: &str) -> Result<TodoListOutput> {
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }

    let user_id = user_id.to_string();
    task::spawn_blocking(move || {
        let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
        let stdout = run_planabrain_simple_command(&root, &["todo-list", &user_id], None)?;
        serde_json::from_str(stdout.trim()).context("todo-list 결과 파싱 실패")
    })
    .await
    .context("todo-list 실행 작업이 중단되었습니다")?
}

pub(crate) async fn interpret_todo_request(
    user_id: &str,
    text: &str,
) -> Result<TodoInterpretOutput> {
    if !is_planabrain_enabled() {
        return Err(anyhow!("planabrain 비활성화"));
    }

    let user_id = user_id.to_string();
    let text = text.to_string();
    task::spawn_blocking(move || {
        let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
        let stdout = run_planabrain_text_command(&root, "todo-interpret", &user_id, &text)?;
        serde_json::from_str(stdout.trim()).context("todo-interpret 결과 파싱 실패")
    })
    .await
    .context("todo-interpret 실행 작업이 중단되었습니다")?
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

    let mut out = String::new();
    for (idx, ch) in text.chars().enumerate() {
        if idx >= limit {
            break;
        }
        out.push(ch);
    }
    out.push('…');
    out
}

fn find_planabrain_root() -> Option<PathBuf> {
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
    if let Ok(raw) = std::env::var("PLANABRAIN_MEMORY_DIR") {
        return Ok(resolve_relative(planabrain_root, &raw));
    }

    let index_path = std::env::var("PLANABRAIN_INDEX_PATH")
        .unwrap_or_else(|_| ".planabrain/index.json".to_string());
    let index_path = resolve_relative(planabrain_root, &index_path);
    let base = index_path
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| planabrain_root.to_path_buf());
    Ok(base.join("memory"))
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

fn run_planabrain_ask_blocking(
    question: &str,
    user_id: &str,
    chat_id: i64,
    conversation_scope_id: Option<&str>,
    image_input: Option<ImageInput>,
) -> Result<String> {
    const MAX_CLI_QUESTION_CHARS: usize = 2000;
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let chat_scope = format!("chat_{chat_id}");

    let mut final_question = question.to_string();
    let mut local_memory_ready = false;
    if is_local_memory_enabled() {
        match prepare_question_with_planabrain_memory(
            &root,
            question,
            user_id,
            &chat_scope,
            conversation_scope_id,
        ) {
            Ok(Some(prepared)) => {
                final_question = prepared;
                local_memory_ready = true;
            }
            Ok(None) => {
                local_memory_ready = true;
            }
            Err(err) => {
                warn!("로컬 장기 메모리 준비 실패: {}", err);
            }
        }
    }

    let mut command = build_planabrain_command(&root)?;
    let repo_root = root.parent().unwrap_or(&root);
    let dotenv_path = repo_root.join(".env");

    let mut question_file = None;
    let command = command
        .current_dir(&root)
        .env("PLANABRAIN_USER_ID", user_id);
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
    if local_memory_ready {
        command.env("PLANABRAIN_MEMORY_ENABLED", "0");
    }
    if dotenv_path.exists() {
        command.env("DOTENV_CONFIG_PATH", dotenv_path);
    }

    if final_question.chars().count() > MAX_CLI_QUESTION_CHARS {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("planabrain_question_{timestamp}.txt"));
        std::fs::write(&path, &final_question).context("planabrain 질문 파일 저장 실패")?;
        command.env("PLANABRAIN_QUESTION_FILE", &path);
        question_file = Some(path);
        command.arg("ask");
    } else {
        command.arg("ask").arg(&final_question);
    }

    let output = match command.output() {
        Ok(output) => output,
        Err(err) => {
            if let Some(path) = question_file.as_ref() {
                let _ = std::fs::remove_file(path);
            }
            if let Some(image_input) = image_input.as_ref() {
                let _ = std::fs::remove_file(&image_input.path);
            }
            return Err(err).context("planabrain 실행 실패");
        }
    };

    if let Some(image_input) = image_input.as_ref() {
        let _ = std::fs::remove_file(&image_input.path);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if let Some(path) = question_file.as_ref() {
            let _ = std::fs::remove_file(path);
        }
        return Err(anyhow!("planabrain 오류: {}", stderr.trim()));
    }

    if let Some(path) = question_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let memory_save_result = if local_memory_ready {
        remember_planabrain_memory_answer(
            &root,
            stdout.trim(),
            user_id,
            &chat_scope,
            conversation_scope_id,
        )
    } else {
        Ok(())
    };
    if let Err(err) = memory_save_result {
        warn!("로컬 장기 메모리 응답 저장 실패: {}", err);
    }
    Ok(stdout)
}

fn build_planabrain_command(root: &Path) -> Result<ProcessCommand> {
    let dist_entry = root.join("dist/cli/index.js");
    let src_entry = root.join("src/cli/index.ts");
    if dist_entry.exists() {
        let mut cmd = ProcessCommand::new("node");
        cmd.arg(dist_entry);
        return Ok(cmd);
    }

    let tsx_path = root.join("node_modules/.bin/tsx");
    if !tsx_path.exists() {
        return Err(anyhow!(
            "planabrain 실행 파일이 없습니다. dist 빌드 또는 tsx 설치가 필요합니다."
        ));
    }

    let mut cmd = ProcessCommand::new(tsx_path);
    cmd.arg(src_entry);
    Ok(cmd)
}

fn run_planabrain_simple_command(
    root: &Path,
    args: &[&str],
    envs: Option<Vec<(&str, PathBuf)>>,
) -> Result<String> {
    let mut command = build_planabrain_command(root)?;
    command.current_dir(root);
    for arg in args {
        command.arg(arg);
    }
    let repo_root = root.parent().unwrap_or(root);
    let dotenv_path = repo_root.join(".env");
    if dotenv_path.exists() {
        command.env("DOTENV_CONFIG_PATH", dotenv_path);
    }
    if let Some(envs) = envs {
        for (key, value) in envs {
            command.env(key, value);
        }
    }

    let output = command.output().context("planabrain 명령 실행 실패")?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("planabrain 오류: {}", stderr.trim()));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_planabrain_text_command(
    root: &Path,
    command_name: &str,
    user_id: &str,
    text: &str,
) -> Result<String> {
    const MAX_CLI_TEXT_CHARS: usize = 2000;
    if text.chars().count() <= MAX_CLI_TEXT_CHARS {
        return run_planabrain_simple_command(root, &[command_name, user_id, text], None);
    }

    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("planabrain_todo_text_{timestamp}.txt"));
    std::fs::write(&path, text).context("todo 텍스트 파일 저장 실패")?;
    let result = run_planabrain_simple_command(
        root,
        &[command_name, user_id],
        Some(vec![("PLANABRAIN_TODO_TEXT_FILE", path.clone())]),
    );
    let _ = std::fs::remove_file(path);
    result
}

fn prepare_question_with_planabrain_memory(
    planabrain_root: &Path,
    question: &str,
    user_id: &str,
    chat_scope: &str,
    conversation_scope_id: Option<&str>,
) -> Result<Option<String>> {
    const MAX_LOCAL_MEMORY_TEXT_CHARS: usize = 2000;
    let mut command = build_planabrain_command(planabrain_root)?;
    let mut text_file = None;
    let command = command
        .current_dir(planabrain_root)
        .arg("memory-prepare")
        .arg(user_id)
        .arg(chat_scope);
    if let Some(conversation_scope_id) = conversation_scope_id {
        command.env("PLANABRAIN_CONVERSATION_ID", conversation_scope_id);
    }

    if question.chars().count() > MAX_LOCAL_MEMORY_TEXT_CHARS {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("local_memory_question_{timestamp}.txt"));
        std::fs::write(&path, question).context("로컬 장기 메모리 질문 파일 저장 실패")?;
        command.env("PLANABRAIN_LOCAL_MEMORY_TEXT_FILE", &path);
        text_file = Some(path);
    } else {
        command.arg(question);
    }

    if let Some(budget) = resolve_local_memory_token_budget() {
        command.arg(budget.to_string());
    }

    let output = command
        .output()
        .context("planabrain memory-prepare 실행 실패")?;

    if let Some(path) = text_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("planabrain memory-prepare 오류: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: LocalMemoryPrepareOutput =
        serde_json::from_str(stdout.trim()).context("memory-prepare 결과 파싱 실패")?;

    let context = parsed.memory_context.trim();
    if context.is_empty() || context.eq_ignore_ascii_case("memory_context: none") {
        return Ok(None);
    }

    Ok(Some(format!(
        "메모리 컨텍스트:\n{}\n\n{}",
        context, question
    )))
}

fn remember_planabrain_memory_answer(
    planabrain_root: &Path,
    answer: &str,
    user_id: &str,
    chat_scope: &str,
    conversation_scope_id: Option<&str>,
) -> Result<()> {
    const MAX_LOCAL_MEMORY_TEXT_CHARS: usize = 2000;
    let mut command = build_planabrain_command(planabrain_root)?;
    let mut text_file = None;
    let command = command
        .current_dir(planabrain_root)
        .arg("memory-assistant")
        .arg(user_id)
        .arg(chat_scope);
    if let Some(conversation_scope_id) = conversation_scope_id {
        command.env("PLANABRAIN_CONVERSATION_ID", conversation_scope_id);
    }

    if answer.chars().count() > MAX_LOCAL_MEMORY_TEXT_CHARS {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("local_memory_answer_{timestamp}.txt"));
        std::fs::write(&path, answer).context("로컬 장기 메모리 응답 파일 저장 실패")?;
        command.env("PLANABRAIN_LOCAL_MEMORY_TEXT_FILE", &path);
        text_file = Some(path);
    } else {
        command.arg(answer);
    }

    let output = command
        .output()
        .context("planabrain memory-assistant 실행 실패")?;

    if let Some(path) = text_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "planabrain memory-assistant 오류: {}",
            stderr.trim()
        ));
    }

    Ok(())
}

fn run_planabrain_memory_reset_user(
    planabrain_root: &Path,
    user_id: &str,
) -> Result<LocalMemoryResetOutput> {
    let mut command = build_planabrain_command(planabrain_root)?;
    let output = command
        .current_dir(planabrain_root)
        .arg("memory-reset-user")
        .arg(user_id)
        .output()
        .context("planabrain memory-reset-user 실행 실패")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!(
            "planabrain memory-reset-user 오류: {}",
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: LocalMemoryResetOutput =
        serde_json::from_str(stdout.trim()).context("memory-reset-user 결과 파싱 실패")?;
    Ok(parsed)
}

fn is_local_memory_enabled() -> bool {
    let Ok(raw) = std::env::var("PLANABOT_LOCAL_MEMORY_ENABLED") else {
        return true;
    };

    let normalized = raw.trim().to_ascii_lowercase();
    !(normalized.is_empty() || normalized == "0" || normalized == "false")
}

fn resolve_local_memory_token_budget() -> Option<u32> {
    std::env::var("PLANABOT_LOCAL_MEMORY_TOKEN_BUDGET")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
}
