use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::Result;
use axum::http::HeaderMap;
use axum::http::header::COOKIE;
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use super::credentials;
use super::password::random_hex;
use crate::persist::read_json_or_default;

pub(crate) const COOKIE_NAME: &str = "planabot_dashboard";
pub(crate) const SESSION_TTL: Duration = Duration::from_secs(12 * 3600);
const MAX_FAILURES: u32 = 5;
const LOCKOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Debug, Default, Serialize, Deserialize)]
struct SessionFile {
    #[serde(default)]
    credential_id: String,
    #[serde(default)]
    sessions: HashMap<String, u64>,
}

struct Limiter {
    failures: u32,
    locked_until: Option<Instant>,
}

static SESSIONS: Lazy<Mutex<SessionFile>> =
    Lazy::new(|| Mutex::new(read_json_or_default(&sessions_path())));
static LIMITER: Mutex<Limiter> = Mutex::new(Limiter {
    failures: 0,
    locked_until: None,
});

pub(crate) fn is_enabled() -> bool {
    !matches!(
        std::env::var("PLANABOT_DASHBOARD_ENABLED")
            .unwrap_or_default()
            .trim()
            .to_ascii_lowercase()
            .as_str(),
        "0" | "false" | "off" | "no"
    )
}

pub(crate) fn is_locked() -> bool {
    let limiter = LIMITER.lock().unwrap_or_else(|p| p.into_inner());
    limiter
        .locked_until
        .is_some_and(|until| until > Instant::now())
}

pub(crate) fn record_failure() {
    let mut limiter = LIMITER.lock().unwrap_or_else(|p| p.into_inner());
    let now = Instant::now();
    if limiter.locked_until.is_some_and(|until| until <= now) {
        limiter.locked_until = None;
        limiter.failures = 0;
    }
    limiter.failures += 1;
    if limiter.failures >= MAX_FAILURES {
        limiter.locked_until = Some(now + LOCKOUT);
        log::warn!("대시보드 인증 실패 누적: {}분 잠금", LOCKOUT.as_secs() / 60);
    }
}

pub(crate) fn record_success() {
    let mut limiter = LIMITER.lock().unwrap_or_else(|p| p.into_inner());
    limiter.failures = 0;
    limiter.locked_until = None;
}

pub(crate) fn create_session() -> Result<String> {
    let session = random_hex::<32>()?;
    let current = credentials::credential_id();
    let mut file = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    if file.credential_id != current {
        file.credential_id = current;
        file.sessions.clear();
    }
    let now = unix_now();
    file.sessions.retain(|_, expires| *expires > now);
    file.sessions
        .insert(session.clone(), now + SESSION_TTL.as_secs());
    save_sessions(&file);
    Ok(session)
}

pub(crate) fn logout(headers: &HeaderMap) {
    let Some(session) = session_from(headers) else {
        return;
    };
    let mut file = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    if file.sessions.remove(&session).is_some() {
        save_sessions(&file);
    }
}

pub(crate) fn is_authenticated(headers: &HeaderMap) -> bool {
    if !is_enabled() {
        return false;
    }
    let Some(session) = session_from(headers) else {
        return false;
    };
    let current = credentials::credential_id();
    if current.is_empty() {
        return false;
    }
    let file = SESSIONS.lock().unwrap_or_else(|p| p.into_inner());
    file.credential_id == current
        && file
            .sessions
            .get(&session)
            .is_some_and(|expires| *expires > unix_now())
}

fn unix_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs())
        .unwrap_or(0)
}

fn sessions_path() -> PathBuf {
    super::store::state_path().with_file_name("dashboard-sessions.json")
}

fn save_sessions(file: &SessionFile) {
    let path = sessions_path();
    let result = serde_json::to_string(file)
        .map_err(std::io::Error::other)
        .and_then(|payload| {
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let tmp = path.with_extension("json.tmp");
            std::fs::write(&tmp, payload)?;
            restrict_permissions(&tmp);
            std::fs::rename(&tmp, &path)
        });
    if let Err(err) = result {
        log::warn!("대시보드 세션 저장 실패: {err}");
    }
}

fn session_from(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|raw| raw.split(';'))
        .filter_map(|pair| pair.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE_NAME)
        .map(|(_, value)| value.to_string())
        .filter(|value| !value.is_empty())
}

#[cfg(unix)]
pub(crate) fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
pub(crate) fn restrict_permissions(_path: &std::path::Path) {}

#[cfg(test)]
mod tests {
    use super::{COOKIE_NAME, session_from};
    use axum::http::{HeaderMap, HeaderValue, header::COOKIE};

    #[test]
    fn reads_session_cookie_among_others() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            HeaderValue::from_str(&format!("theme=dark; {COOKIE_NAME}=abc123; x=y")).unwrap(),
        );
        assert_eq!(session_from(&headers).as_deref(), Some("abc123"));
    }

    #[test]
    fn ignores_missing_or_empty_cookie() {
        let mut headers = HeaderMap::new();
        assert!(session_from(&headers).is_none());
        headers.insert(
            COOKIE,
            HeaderValue::from_str(&format!("{COOKIE_NAME}=")).unwrap(),
        );
        assert!(session_from(&headers).is_none());
    }
}
