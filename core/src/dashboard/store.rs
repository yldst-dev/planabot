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
    "ANTHROPIC_",
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

#[derive(Debug, Serialize)]
pub(crate) struct EntryError {
    pub key: String,
    pub message: String,
}

impl std::fmt::Display for EntryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.key, self.message)
    }
}

impl std::error::Error for EntryError {}

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
        if let Err(err) = validate_stored_entry(&key, &value) {
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
        .keys()
        .cloned()
        .chain(applied_keys().map(str::to_string))
        .filter(|key| {
            let next = file
                .values
                .get(key)
                .filter(|value| !is_ignored(key, value))
                .cloned()
                .or_else(|| baseline_value(key));
            let running = applied_value(key)
                .map(str::to_string)
                .or_else(|| baseline_value(key));
            next != running
        })
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

pub(crate) async fn update(changes: BTreeMap<String, Option<String>>) -> Result<OverrideFile> {
    for (key, value) in &changes {
        check_change(key, value.as_deref())?;
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

pub(crate) fn check_change(key: &str, value: Option<&str>) -> Result<(), EntryError> {
    let checked = match value {
        Some(value) => validate_entry(key, value),
        None => validate_format(key),
    };
    checked.map_err(|err| EntryError {
        key: key.to_string(),
        message: err.to_string(),
    })
}

pub(crate) fn is_ignored(key: &str, value: &str) -> bool {
    validate_stored_entry(key, value).is_err()
}

fn validate_format(key: &str) -> Result<()> {
    let well_formed = !key.is_empty()
        && key.len() <= 64
        && key.starts_with(|c: char| c.is_ascii_uppercase())
        && key
            .chars()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_');
    if !well_formed {
        bail!("키 형식 오류");
    }
    Ok(())
}

pub(crate) fn validate_key(key: &str) -> Result<()> {
    validate_format(key)?;
    if BLOCKED_KEYS.contains(&key) {
        bail!("변경 불가 키");
    }
    let field = catalog::find(key);
    if field.is_some_and(|field| field.env_only) {
        bail!("env에서만 바꿀 수 있는 키");
    }
    let known = field.is_some();
    if !known
        && !ALLOWED_PREFIXES
            .iter()
            .any(|prefix| key.starts_with(prefix))
    {
        bail!("허용되지 않은 접두사");
    }
    Ok(())
}

fn validate_stored_entry(key: &str, value: &str) -> Result<()> {
    validate_key(key)?;
    if value.len() > MAX_VALUE_BYTES {
        bail!("값이 너무 깁니다");
    }
    if value.contains('\0') {
        bail!("값에 NUL 문자");
    }
    Ok(())
}

fn validate_entry(key: &str, value: &str) -> Result<()> {
    validate_stored_entry(key, value)?;
    if matches!(
        key,
        "PLANABRAIN_ALLOWED_USER_IDS" | "PLANABRAIN_ALLOWED_CHAT_IDS"
    ) && crate::planabrain::id_list_tokens(value).any(|token| token.parse::<i64>().is_err())
    {
        bail!("숫자 ID만 쉼표로 구분해 입력하십시오");
    }
    let id = value.trim();
    if key.ends_with("_CHAT_ID") && !id.is_empty() && id.parse::<i64>().is_err() {
        bail!("채팅 ID는 숫자로 입력하십시오");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{OverrideFile, check_change, pending_keys, validate_entry, validate_key};

    #[test]
    fn chat_ids_must_be_empty_or_a_number() {
        assert!(validate_entry("PLANABOT_ADMIN_CHAT_ID", "").is_ok());
        assert!(validate_entry("PLANABOT_ADMIN_CHAT_ID", " 123456789 ").is_ok());
        assert!(validate_entry("PLANABOT_NOTICE_CHAT_ID", "-1001234567890").is_ok());
        for value in ["@admin", "12 34", "1e5", "１２３", "-100123456789012345678"] {
            assert!(
                validate_entry("PLANABOT_NOTICE_CHAT_ID", value).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn deleting_checks_only_the_key_format() {
        for key in ["HEALTH_SECRET_CORE", "PATH", "PLANABRAIN_SERVER_TOKEN"] {
            assert!(check_change(key, None).is_ok(), "{key}");
            assert!(check_change(key, Some("x")).is_err(), "{key}");
        }
        let err = check_change("bad key", None).expect_err("format");
        assert_eq!(
            (err.key.as_str(), err.message.as_str()),
            ("bad key", "키 형식 오류")
        );
    }

    #[test]
    fn ignored_entries_are_not_pending() {
        let mut file = OverrideFile::default();
        file.values.insert("PATH".to_string(), "/tmp".to_string());
        file.values
            .insert("PLANABOT_PENDING_PROBE".to_string(), "1".to_string());
        assert_eq!(pending_keys(&file), ["PLANABOT_PENDING_PROBE"]);
    }

    #[test]
    fn accepts_catalog_and_prefixed_keys() {
        assert!(validate_key("PLANABRAIN_NEW_FLAG").is_ok());
        assert!(validate_key("CODEX_GATEWAY_BASE_URL").is_ok());
        assert!(validate_key("ANTHROPIC_API_KEY").is_ok());
        assert!(validate_key("PLANABRAIN_ANTHROPIC_MODEL").is_ok());
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
        assert!(validate_key("HEALTH_PORT").is_err());
        assert!(validate_key("HEALTH_SECRET_BRAIN").is_err());
        assert!(validate_key("HEALTH_SECRET_CORE").is_err());
        assert!(validate_key("HIROMI_DOWNLOAD_DIR").is_err());
        assert!(validate_key("TELEGRAM_API_TOKEN").is_err());
        assert!(validate_key(&"PLANABOT_X".repeat(10)).is_err());
    }

    #[test]
    fn rejects_nul_and_oversized_values() {
        assert!(validate_entry("PLANABRAIN_CODEX_MODEL", "a\0b").is_err());
        assert!(validate_entry("PLANABRAIN_CODEX_MODEL", &"a".repeat(40_000)).is_err());
        assert!(validate_entry("PLANABRAIN_SYSTEM_PROMPT", "줄 하나\n줄 둘").is_ok());
    }

    #[test]
    fn allowed_id_lists_accept_only_numeric_ids() {
        assert!(validate_entry("PLANABRAIN_ALLOWED_USER_IDS", "123456789, 42").is_ok());
        assert!(validate_entry("PLANABRAIN_ALLOWED_CHAT_IDS", "-1001234567890").is_ok());
        assert!(validate_entry("PLANABRAIN_ALLOWED_USER_IDS", "").is_ok());
        for value in ["\"123456789\"", "@name", "[123]", "１２３", "123，456"] {
            assert!(
                validate_entry("PLANABRAIN_ALLOWED_USER_IDS", value).is_err(),
                "{value}"
            );
        }
    }

    #[test]
    fn parses_file_without_values_field() {
        let file: OverrideFile = serde_json::from_str("{}").unwrap();
        assert!(file.values.is_empty());
    }
}
