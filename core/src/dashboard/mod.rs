mod account;
mod auth;
mod catalog;
mod credentials;
mod password;
pub(crate) mod store;
mod web;

use std::collections::BTreeMap;
use std::sync::OnceLock;
use std::time::Duration;

use axum::http::header::CACHE_CONTROL;
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use catalog::{Group, Kind};

const CSRF_HEADER: &str = "x-planabot-dashboard";

static BOT_USERNAME: OnceLock<String> = OnceLock::new();

pub(crate) fn set_bot_username(username: &str) {
    let _ = BOT_USERNAME.set(username.to_string());
}

pub(crate) fn router() -> Router {
    if auth::is_enabled() {
        log::info!(
            "설정 대시보드 사용: / 경로, 화면 파일 {}",
            web::dist_dir().display()
        );
        account::announce_setup_code();
    } else {
        log::info!("설정 대시보드 비활성: PLANABOT_DASHBOARD_ENABLED=0");
    }
    Router::new()
        .route("/", get(web::index))
        .route("/favicon.svg", get(web::favicon))
        .route("/assets/{name}", get(web::asset))
        .route("/api/session", get(account::session))
        .route("/api/setup", post(account::setup))
        .route("/api/login", post(account::login))
        .route("/api/recover", post(account::recover))
        .route("/api/logout", post(account::logout))
        .route("/api/password", post(account::change_password))
        .route("/api/recovery-code", post(account::regenerate_recovery))
        .route("/api/overview", get(overview))
        .route("/api/settings", get(settings).put(save_settings))
        .route("/api/settings/import-env", post(import_env))
        .route("/api/restart", post(restart))
}

fn apply_security_headers(headers: &mut HeaderMap) {
    headers.insert(
        HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        HeaderName::from_static("referrer-policy"),
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
}

fn json<T: Serialize>(status: StatusCode, value: &T) -> Response {
    let mut response = (status, Json(value)).into_response();
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    apply_security_headers(response.headers_mut());
    response
}

fn error(status: StatusCode, message: &str) -> Response {
    json(status, &serde_json::json!({ "error": message }))
}

fn reject(headers: &HeaderMap, mutating: bool) -> Option<Response> {
    if mutating && headers.get(CSRF_HEADER).and_then(|v| v.to_str().ok()) != Some("1") {
        return Some(error(StatusCode::FORBIDDEN, "요청 형식 오류."));
    }
    if !auth::is_authenticated(headers) {
        return Some(error(StatusCode::UNAUTHORIZED, "인증 필요."));
    }
    None
}

fn is_https(headers: &HeaderMap) -> bool {
    headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|proto| proto.eq_ignore_ascii_case("https"))
}

fn session_cookie(value: &str, max_age: u64, secure: bool) -> HeaderValue {
    let secure = if secure { "; Secure" } else { "" };
    let raw = format!(
        "{}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={max_age}{secure}",
        auth::COOKIE_NAME
    );
    HeaderValue::from_str(&raw).unwrap_or_else(|_| HeaderValue::from_static(""))
}

#[derive(Serialize)]
struct OverviewView {
    version: &'static str,
    uptime: u64,
    bot_username: Option<String>,
    provider: &'static str,
    model: String,
    aux_model: Option<String>,
    planabrain_server: bool,
    overrides: usize,
    pending: Vec<String>,
    state_path: String,
    allowed_chats: usize,
    allowed_users: usize,
}

fn running(key: &str) -> Option<String> {
    std::env::var(key)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn count_list(key: &str) -> usize {
    running(key)
        .map(|raw| crate::planabrain::parse_id_list(&raw).len())
        .unwrap_or(0)
}

async fn overview(headers: HeaderMap) -> Response {
    if let Some(response) = reject(&headers, false) {
        return response;
    }
    let file = store::load();
    let anthropic = running("PLANABRAIN_AI_PROVIDER")
        .map(|provider| provider.to_ascii_lowercase())
        .is_some_and(|provider| provider == "anthropic" || provider == "claude");
    let (provider, model, aux_model) = if anthropic {
        (
            "anthropic",
            running("PLANABRAIN_ANTHROPIC_MODEL").unwrap_or_else(|| "claude-opus-5-5".to_string()),
            running("PLANABRAIN_ANTHROPIC_AUX_MODEL")
                .or_else(|| Some("claude-haiku-5-5".to_string())),
        )
    } else {
        (
            "codex",
            running("PLANABRAIN_CODEX_MODEL").unwrap_or_else(|| "gpt-6-astra".to_string()),
            running("PLANABRAIN_AUX_MODEL"),
        )
    };
    json(
        StatusCode::OK,
        &OverviewView {
            version: env!("CARGO_PKG_VERSION"),
            uptime: crate::health::uptime_secs(),
            bot_username: BOT_USERNAME.get().cloned(),
            provider,
            model,
            aux_model,
            planabrain_server: crate::planabrain::server::is_ready(),
            overrides: file.values.len(),
            pending: store::pending_keys(&file),
            state_path: store::state_path().display().to_string(),
            allowed_chats: count_list("PLANABRAIN_ALLOWED_CHAT_IDS"),
            allowed_users: count_list("PLANABRAIN_ALLOWED_USER_IDS"),
        },
    )
}

#[derive(Serialize)]
struct FieldView {
    key: String,
    group: &'static str,
    label: String,
    help: &'static str,
    kind: Kind,
    options: &'static [&'static str],
    placeholder: &'static str,
    value: Option<String>,
    env_value: Option<String>,
    hint: Option<String>,
    env_hint: Option<String>,
    source: &'static str,
    pending: bool,
    custom: bool,
    env_only: bool,
    ignored: bool,
}

#[derive(Serialize)]
struct SettingsView {
    groups: &'static [Group],
    fields: Vec<FieldView>,
    pending: Vec<String>,
}

fn mask(value: &str) -> String {
    let chars: Vec<char> = value.chars().collect();
    if chars.len() >= 12 {
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("•••• {tail}")
    } else {
        "••••".to_string()
    }
}

fn field_view(
    key: &str,
    field: Option<&'static catalog::Field>,
    stored: Option<&String>,
    pending: bool,
) -> FieldView {
    let kind = match field {
        Some(field) => field.kind,
        None if catalog::looks_secret(key) => Kind::Secret,
        None => Kind::Text,
    };
    let env_value = store::baseline_value(key);
    let source = match (stored, &env_value) {
        (Some(_), _) => "dashboard",
        (None, Some(_)) => "env",
        (None, None) => "unset",
    };
    let ignored = stored.is_some_and(|value| store::is_ignored(key, value));
    let effective = stored
        .filter(|_| !ignored)
        .cloned()
        .or_else(|| env_value.clone());
    let secret = kind == Kind::Secret;
    FieldView {
        key: key.to_string(),
        group: field.map(|field| field.group).unwrap_or("custom"),
        label: field
            .map(|field| field.label.to_string())
            .unwrap_or_else(|| key.to_string()),
        help: field.map(|field| field.help).unwrap_or(""),
        kind,
        options: field.map(|field| field.options).unwrap_or(&[]),
        placeholder: field.map(|field| field.placeholder).unwrap_or(""),
        value: if secret { None } else { effective.clone() },
        env_value: if secret { None } else { env_value.clone() },
        hint: if secret {
            effective.as_deref().map(mask)
        } else {
            None
        },
        env_hint: if secret {
            env_value.as_deref().map(mask)
        } else {
            None
        },
        source,
        pending,
        custom: field.is_none(),
        env_only: field.is_some_and(|field| field.env_only),
        ignored,
    }
}

fn settings_view() -> SettingsView {
    let file = store::load();
    let pending = store::pending_keys(&file);
    let is_pending = |key: &str| pending.iter().any(|item| item == key);
    let mut fields: Vec<FieldView> = catalog::FIELDS
        .iter()
        .map(|field| {
            field_view(
                field.key,
                Some(field),
                file.values.get(field.key),
                is_pending(field.key),
            )
        })
        .collect();
    let mut custom_keys: Vec<String> = file
        .values
        .keys()
        .cloned()
        .chain(store::applied_keys().map(str::to_string))
        .filter(|key| catalog::find(key).is_none())
        .collect();
    custom_keys.sort_unstable();
    custom_keys.dedup();
    fields.extend(
        custom_keys
            .iter()
            .map(|key| field_view(key, None, file.values.get(key), is_pending(key))),
    );
    SettingsView {
        groups: catalog::GROUPS,
        fields,
        pending,
    }
}

async fn settings(headers: HeaderMap) -> Response {
    if let Some(response) = reject(&headers, false) {
        return response;
    }
    json(StatusCode::OK, &settings_view())
}

#[derive(Deserialize)]
struct SaveRequest {
    changes: BTreeMap<String, Option<String>>,
}

async fn save_settings(headers: HeaderMap, Json(body): Json<SaveRequest>) -> Response {
    if let Some(response) = reject(&headers, true) {
        return response;
    }
    if body.changes.is_empty() {
        return json(StatusCode::OK, &settings_view());
    }
    let keys: Vec<String> = body.changes.keys().cloned().collect();
    match store::update(body.changes).await {
        Ok(_) => {
            log::info!("대시보드 설정 저장: {}", keys.join(", "));
            json(StatusCode::OK, &settings_view())
        }
        Err(err) => match err.downcast_ref::<store::EntryError>() {
            Some(entry) => json(
                StatusCode::BAD_REQUEST,
                &serde_json::json!({ "error": entry.message, "key": entry.key }),
            ),
            None => write_failed(&err),
        },
    }
}

fn write_failed(err: &anyhow::Error) -> Response {
    log::error!("대시보드 설정 파일 저장 실패: {err}");
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "설정 파일을 저장하지 못했습니다.",
    )
}

#[derive(Deserialize)]
struct ImportRequest {
    keys: Vec<String>,
}

#[derive(Serialize)]
struct ImportView {
    imported: Vec<String>,
    skipped: Vec<store::EntryError>,
    settings: SettingsView,
}

fn importable_env(
    keys: &[String],
    file: &store::OverrideFile,
    env: impl Fn(&str) -> Option<String>,
) -> (BTreeMap<String, Option<String>>, Vec<store::EntryError>) {
    let mut skipped = Vec::new();
    let changes = keys
        .iter()
        .filter(|key| catalog::find(key).is_some_and(|field| !field.env_only))
        .filter(|key| !file.values.contains_key(*key))
        .filter_map(|key| {
            env(key)
                .filter(|value| !value.trim().is_empty())
                .map(|value| (key.clone(), Some(value)))
        })
        .filter(
            |(key, value)| match store::check_change(key, value.as_deref()) {
                Ok(()) => true,
                Err(err) => {
                    skipped.push(err);
                    false
                }
            },
        )
        .collect();
    (changes, skipped)
}

async fn import_env(headers: HeaderMap, Json(body): Json<ImportRequest>) -> Response {
    if let Some(response) = reject(&headers, true) {
        return response;
    }
    let (changes, skipped) = importable_env(&body.keys, &store::load(), store::baseline_value);
    let imported: Vec<String> = changes.keys().cloned().collect();
    if !changes.is_empty() {
        if let Err(err) = store::update(changes).await {
            return write_failed(&err);
        }
        log::info!("대시보드로 env 값 가져오기: {}", imported.join(", "));
    }
    json(
        StatusCode::OK,
        &ImportView {
            imported,
            skipped,
            settings: settings_view(),
        },
    )
}

async fn restart(headers: HeaderMap) -> Response {
    if let Some(response) = reject(&headers, true) {
        return response;
    }
    tokio::spawn(async {
        tokio::time::sleep(Duration::from_millis(700)).await;
        if !crate::bot::request_shutdown() {
            crate::reboot::trigger_scheduled_reboot("대시보드 설정 적용");
        }
    });
    json(StatusCode::ACCEPTED, &serde_json::json!({ "ok": true }))
}

pub(crate) fn reset_password() -> anyhow::Result<()> {
    let code = credentials::reset()?;
    println!("대시보드 비밀번호를 지웠습니다. 기존 로그인 세션도 모두 끊겼습니다.");
    println!("설정 코드: {code}");
    println!("대시보드에 접속해 이 코드와 새 비밀번호를 입력하십시오.");
    println!("인증 파일: {}", credentials::path().display());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{field_view, importable_env, mask, store::OverrideFile};

    #[test]
    fn masks_secrets_without_leaking_short_values() {
        assert_eq!(mask("short"), "••••");
        assert_eq!(mask("123456:ABCDEFGHwxyz"), "•••• wxyz");
    }

    #[test]
    fn secret_fields_never_expose_values() {
        let stored = "super-secret-token-value".to_string();
        let view = field_view(
            "CODEX_GATEWAY_API_KEY",
            super::catalog::find("CODEX_GATEWAY_API_KEY"),
            Some(&stored),
            true,
        );
        assert!(view.value.is_none());
        assert!(view.env_value.is_none());
        assert_eq!(view.hint.as_deref(), Some("•••• alue"));
        assert_eq!(view.source, "dashboard");
        assert!(!view.ignored);
    }

    #[test]
    fn ignored_stored_entries_show_the_running_value() {
        let stored = "/stored".to_string();
        let view = field_view("PATH", None, Some(&stored), false);
        assert!(view.ignored);
        assert_eq!(view.source, "dashboard");
        assert_eq!(view.value, std::env::var("PATH").ok());
    }

    #[test]
    fn env_import_takes_only_unsaved_catalog_keys_with_env_values() {
        let mut file = OverrideFile::default();
        file.values
            .insert("PLANABRAIN_CODEX_MODEL".to_string(), "saved".to_string());
        let keys: Vec<String> = [
            "PLANABRAIN_AUX_MODEL",
            "PLANABRAIN_CODEX_FAST",
            "PLANABRAIN_CODEX_MODEL",
            "HEALTH_PORT",
            "PLANABRAIN_NOT_IN_CATALOG",
            "PATH",
            "PLANABRAIN_MEMORY_MAX_TURNS",
            "PLANABOT_ADMIN_CHAT_ID",
        ]
        .iter()
        .map(|key| key.to_string())
        .collect();
        let env = |key: &str| match key {
            "PLANABRAIN_CODEX_FAST" => Some("  ".to_string()),
            "PLANABRAIN_MEMORY_MAX_TURNS" => None,
            _ => Some(format!("env-{key}")),
        };
        let (changes, skipped) = importable_env(&keys, &file, env);
        assert_eq!(
            changes.into_iter().collect::<Vec<_>>(),
            vec![(
                "PLANABRAIN_AUX_MODEL".to_string(),
                Some("env-PLANABRAIN_AUX_MODEL".to_string())
            )]
        );
        assert_eq!(
            serde_json::to_value(&skipped).unwrap(),
            serde_json::json!([{
                "key": "PLANABOT_ADMIN_CHAT_ID",
                "message": "채팅 ID는 숫자로 입력하십시오"
            }])
        );
    }

    #[test]
    fn env_only_fields_are_flagged() {
        let view = field_view(
            "HIROMI_BIN",
            super::catalog::find("HIROMI_BIN"),
            None,
            false,
        );
        assert!(view.env_only);
        assert!(!view.custom);
    }

    #[test]
    fn unknown_secret_like_keys_are_masked() {
        let stored = "abcdefghijklmnop".to_string();
        let view = field_view("PLANABRAIN_EXTRA_API_KEY", None, Some(&stored), false);
        assert!(view.custom);
        assert!(view.value.is_none());
        assert_eq!(view.group, "custom");
    }
}
