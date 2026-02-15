use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use tokio::task;

const MAX_INLINE_TEXT_CHARS: usize = 2000;

#[derive(Debug, Clone)]
pub(crate) struct TokenCount {
    pub total_tokens: u32,
}

#[derive(Debug, Deserialize)]
struct CliTokenCount {
    #[serde(alias = "token_count")]
    tokens: u32,
}

pub(crate) async fn count_text_tokens(text: &str) -> Result<TokenCount> {
    let text = text.to_string();
    let handle = task::spawn_blocking(move || count_text_tokens_blocking(&text));
    handle.await.context("토큰 측정 작업이 중단되었습니다")?
}

fn count_text_tokens_blocking(text: &str) -> Result<TokenCount> {
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let model = resolve_token_model();

    let dist_entry = root.join("dist/cli/index.js");
    let src_entry = root.join("src/cli/index.ts");
    let mut command = if dist_entry.exists() {
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

    let repo_root = root.parent().unwrap_or(&root);
    let dotenv_path = repo_root.join(".env");
    let command = command.current_dir(&root);
    if dotenv_path.exists() {
        command.env("DOTENV_CONFIG_PATH", dotenv_path);
    }

    let mut text_file = None;
    command.arg("tokens").arg(&model);
    if text.chars().count() > MAX_INLINE_TEXT_CHARS {
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        let path = std::env::temp_dir().join(format!("planabot_tokens_{timestamp}.txt"));
        std::fs::write(&path, text).context("토큰 측정 입력 파일 저장 실패")?;
        command.env("PLANABOT_TOKEN_TEXT_FILE", &path);
        text_file = Some(path);
    } else {
        command.arg(text);
    }

    let output = command.output().context("planabrain tokens 실행 실패")?;

    if let Some(path) = text_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("토큰 측정 실패: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let parsed: CliTokenCount =
        serde_json::from_str(stdout.trim()).context("토큰 측정 결과 파싱 실패")?;

    Ok(TokenCount {
        total_tokens: parsed.tokens,
    })
}

fn find_planabrain_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let candidates = [cwd.join("planabrain"), cwd.join("..").join("planabrain")];
    candidates
        .into_iter()
        .find(|candidate| candidate.join("package.json").exists())
}

fn resolve_token_model() -> String {
    env_var_trimmed("PLANABOT_TOKEN_MODEL")
        .or_else(|| env_var_trimmed("PLANABRAIN_GEMINI_MODEL"))
        .map(|value| normalize_model_name(&value))
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

fn env_var_trimmed(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_model_name(value: &str) -> String {
    value
        .trim()
        .trim_start_matches("models/")
        .trim()
        .to_string()
}
