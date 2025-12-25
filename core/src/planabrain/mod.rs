use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::process::Command as ProcessCommand;

use anyhow::{Context, Result, anyhow};
use once_cell::sync::Lazy;
use tokio::task;

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

pub(crate) async fn run_planabrain_ask(question: &str, user_id: &str) -> Result<String> {
    let question = question.to_string();
    let user_id = user_id.to_string();

    let handle = task::spawn_blocking(move || run_planabrain_ask_blocking(&question, &user_id));
    handle
        .await
        .context("planabrain 실행 작업이 중단되었습니다")?
}

pub(crate) async fn reset_user_memory(user_id: &str) -> Result<bool> {
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let memory_file = planabrain_memory_file(&root, user_id)?;

    match tokio::fs::remove_file(&memory_file).await {
        Ok(()) => Ok(true),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

pub(crate) fn is_planabrain_allowed(chat_id: i64, user_id: Option<i64>, is_private: bool) -> bool {
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
    out.push_str("\n…");
    out
}

fn find_planabrain_root() -> Option<PathBuf> {
    let cwd = std::env::current_dir().ok()?;
    let candidates = [cwd.join("planabrain"), cwd.join("..").join("planabrain")];

    for candidate in candidates {
        if candidate.join("package.json").exists() {
            return Some(candidate);
        }
    }

    None
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
fn run_planabrain_ask_blocking(question: &str, user_id: &str) -> Result<String> {
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;

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

    let command = command.current_dir(&root).env("PLANABRAIN_USER_ID", user_id);
    if dotenv_path.exists() {
        command.env("DOTENV_CONFIG_PATH", dotenv_path);
    }

    let output = command
        .arg("ask")
        .arg(question)
        .output()
        .context("planabrain 실행 실패")?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(anyhow!("planabrain 오류: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    Ok(stdout)
}
