use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use std::time::Duration;

const MAX_INLINE_TEXT_CHARS: usize = 2000;
const TOKEN_COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

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
    let root = crate::planabrain::find_planabrain_root()
        .context("planabrain 디렉터리를 찾지 못했습니다")?;
    let model = resolve_token_model();

    let mut command = crate::planabrain::build_planabrain_command(&root)?;
    command.current_dir(&root);
    let repo_root = root.parent().unwrap_or(&root);
    let dotenv_path = repo_root.join(".env");
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

    let result =
        crate::planabrain::run_planabrain_output(command, None, TOKEN_COMMAND_TIMEOUT, "tokens")
            .await;

    if let Some(path) = text_file.as_ref() {
        let _ = std::fs::remove_file(path);
    }
    let output = result?;

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

fn resolve_token_model() -> String {
    env_var_trimmed("PLANABOT_TOKEN_MODEL")
        .or_else(|| env_var_trimmed("PLANABRAIN_CODEX_MODEL"))
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
