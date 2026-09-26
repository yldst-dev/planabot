use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::OnceLock;

use anyhow::{Result, bail};
use log::{info, warn};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use super::catalog;
use crate::persist::{read_json_or_default, write_json_atomic};

const MAX_VALUE_BYTES: usize = 32 * 1024;
const ALLOWED_PREFIXES: &[&str] = &[
    "PLANABOT_",
    "PLANABRAIN_",
    "CODEX_",
    "OLLAMA_",
    "OPENROUTER_",
    "SENDVIS_",
];
const BLOCKED_KEYS: &[&str] = &[
    "PLANABOT_DASHBOARD_ENABLED",
    "PLANABOT_DASHBOARD_STATE_PATH",
    "PLANABOT_DASHBOARD_DIR",
    "PLANABRAIN_SERVER_TOKEN",
];

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct OverrideFile {
    #[serde(default)]
    pub values: BTreeMap<String, String>,
}

struct Startup {
    baseline: BTreeMap<String, Option<String>>,
    applied: BTreeMap<String, String>,
}

static STARTUP: OnceLock<Startup> = OnceLock::new();
static WRITE_LOCK: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));

pub(crate) fn state_path() -> PathBuf {
    let raw = std::env::var("PLANABOT_DASHBOARD_STATE_PATH")
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| ".planabot/dashboard.json".to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub(crate) fn apply_startup_overrides() {
    let path = state_path();
    let file: OverrideFile = read_json_or_default(&path);
    let mut baseline = BTreeMap::new();
    let mut applied = BTreeMap::new();
    for (key, value) in file.values {
        if let Err(err) = validate_entry(&key, &value) {
            warn!("대시보드 설정 무시: {key} ({err})");
            continue;
        }
        baseline.insert(key.clone(), std::env::var(&key).ok());
        unsafe {
            std::env::set_var(&key, &value);
        }
        applied.insert(key, value);
    }
    if !applied.is_empty() {
        info!("대시보드 설정 {}개 적용: {}", applied.len(), path.display());
    }
    let _ = STARTUP.set(Startup { baseline, applied });
}

pub(crate) fn baseline_value(key: &str) -> Option<String> {
    match STARTUP.get().and_then(|startup| startup.baseline.get(key)) {
        Some(value) => value.clone(),
        None => std::env::var(key).ok(),
    }
}

pub(crate) fn applied_value(key: &str) -> Option<&'static str> {
    STARTUP
        .get()
        .and_then(|startup| startup.applied.get(key))
        .map(String::as_str)
}

pub(crate) fn applied_keys() -> impl Iterator<Item = &'static str> {
    STARTUP
        .get()
        .into_iter()
        .flat_map(|startup| startup.applied.keys().map(String::as_str))
}

pub(crate) fn load() -> OverrideFile {
    read_json_or_default(&state_path())
}

pub(crate) fn pending_keys(file: &OverrideFile) -> Vec<String> {
    let mut keys: Vec<String> = file
        .values
        .iter()
        .filter(|(key, value)| applied_value(key) != Some(value.as_str()))
        .map(|(key, _)| key.clone())
        .collect();
    keys.extend(
        applied_keys()
            .filter(|key| !file.values.contains_key(*key))
            .map(str::to_string),
    );
    keys.sort();
    keys
}

pub(crate) async fn update(changes: BTreeMap<String, Option<String>>) -> Result<OverrideFile> {
    for (key, value) in &changes {
        match value {
            Some(value) => validate_entry(key, value)?,
            None => validate_key(key)?,
        }
    }
    let _guard = WRITE_LOCK.lock().await;
    let mut file = load();
    for (key, value) in changes {
        match value {
            Some(value) => {
                file.values.insert(key, value);
            }
            None => {
                file.values.remove(&key);
            }
        }
    }
    let path = state_path();
    write_json_atomic(&path, &file).await?;
    super::auth::restrict_permissions(&path);
    Ok(file)
}

pub(crate) fn validate_key(key: &str) -> Result<()> {
    let well_formed = !key.is_empty()
        && key.len() <= 64
        && key.starts_with(|c: char| c.is_ascii_uppercase())
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !well_formed {
        bail!("키 형식 오류");
    }
    if BLOCKED_KEYS.contains(&key) {
        bail!("변경 불가 키");
    }
    let known = catalog::find(key).is_some();
    if !known
        && !ALLOWED_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
    {
        bail!("허용되지 않은 접두사");
    }
    Ok(())
}

fn validate_entry(key: &str, value: &str) -> Result<()> {
    validate_key(key)?;
    if value.len() > MAX_VALUE_BYTES {
        bail!("값이 너무 깁니다");
    }
    if value.contains('\0') {
        bail!("값에 NUL 문자");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{OverrideFile, validate_entry, validate_key};

    #[test]
    fn accepts_catalog_and_prefixed_keys() {
        assert!(validate_key("TELEGRAM_API_TOKEN").is_ok());
        assert!(validate_key("PLANABRAIN_NEW_FLAG").is_ok());
        assert!(validate_key("CODEX_GATEWAY_BASE_URL").is_ok());
        assert!(validate_key("MEMORY_FLOW_ROOT").is_err());
        assert!(validate_key("GOOGLE_API_KEY").is_err());
    }

    #[test]
    fn rejects_malformed_blocked_and_foreign_keys() {
        assert!(validate_key("").is_err());
        assert!(validate_key("lower_case").is_err());
        assert!(validate_key("PLANABRAIN-DASH").is_err());
        assert!(validate_key("1PLANABOT").is_err());
        assert!(validate_key("PLANABOT_DASHBOARD_ENABLED").is_err());
        assert!(validate_key("PLANABOT_DASHBOARD_DIR").is_err());
        assert!(validate_key("PLANABRAIN_SERVER_TOKEN").is_err());
        assert!(validate_key("LD_PRELOAD").is_err());
        assert!(validate_key("PATH").is_err());
        assert!(validate_key("HIROMI_BIN").is_err());
        assert!(validate_key(&"PLANABOT_X".repeat(10)).is_err());
    }

    #[test]
    fn rejects_nul_and_oversized_values() {
        assert!(validate_entry("PLANABRAIN_CODEX_MODEL", "a\0b").is_err());
        assert!(validate_entry("PLANABRAIN_CODEX_MODEL", &"a".repeat(40_000)).is_err());
        assert!(validate_entry("PLANABRAIN_SYSTEM_PROMPT", "줄 하나\n줄 둘").is_ok());
    }

    #[test]
    fn parses_file_without_values_field() {
        let file: OverrideFile = serde_json::from_str("{}").unwrap();
        assert!(file.values.is_empty());
    }
}
