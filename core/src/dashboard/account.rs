use axum::Json;
use axum::http::header::SET_COOKIE;
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};

use super::credentials::{self, Outcome};
use super::{CSRF_HEADER, auth, error, is_https, json, reject, session_cookie};

#[derive(Serialize)]
struct SessionView {
    enabled: bool,
    configured: bool,
    authenticated: bool,
}

#[derive(Deserialize)]
pub(crate) struct SetupRequest {
    setup_code: String,
    password: String,
}

#[derive(Deserialize)]
pub(crate) struct LoginRequest {
    password: String,
}

#[derive(Deserialize)]
pub(crate) struct RecoverRequest {
    recovery_code: String,
    password: String,
}

#[derive(Deserialize)]
pub(crate) struct ChangeRequest {
    current_password: String,
    password: String,
}

#[derive(Deserialize)]
pub(crate) struct ConfirmRequest {
    password: String,
}

#[derive(Serialize)]
struct RecoveryView {
    recovery_code: String,
}

pub(crate) fn announce_setup_code() {
    if !auth::is_enabled() {
        return;
    }
    match credentials::rotate_setup_code() {
        Ok(Some(code)) => log_setup_code(&code),
        Ok(None) => {}
        Err(err) => log::error!("대시보드 설정 코드 생성 실패: {err:#}"),
    }
}

fn log_setup_code(code: &str) {
    log::warn!(
        "대시보드 비밀번호가 아직 없습니다. 첫 접속 화면에 설정 코드 {code} 를 입력하십시오."
    );
}

pub(crate) async fn session(headers: HeaderMap) -> Response {
    let enabled = auth::is_enabled();
    let configured = blocking(credentials::is_configured).await.unwrap_or(false);
    let fresh = if enabled && !configured {
        blocking(credentials::ensure_setup_code).await
    } else {
        None
    };
    if let Some(Ok(Some(code))) = fresh {
        log_setup_code(&code);
    }
    json(
        StatusCode::OK,
        &SessionView {
            enabled,
            configured,
            authenticated: configured && auth::is_authenticated(&headers),
        },
    )
}

pub(crate) async fn setup(headers: HeaderMap, Json(body): Json<SetupRequest>) -> Response {
    if let Some(response) = precheck(&headers) {
        return response;
    }
    let result = blocking(move || credentials::setup(&body.setup_code, &body.password)).await;
    match result {
        Some(Ok(Outcome::Done(code))) => {
            log::info!("대시보드 비밀번호 최초 설정 완료");
            signed_in(
                &headers,
                StatusCode::OK,
                &RecoveryView {
                    recovery_code: code,
                },
            )
        }
        Some(Ok(Outcome::Rejected)) => failed("설정 코드 불일치. 봇 로그에서 코드를 확인하십시오."),
        Some(Ok(Outcome::Invalid(message))) => error(StatusCode::BAD_REQUEST, &message),
        Some(Ok(Outcome::Unavailable)) => {
            error(StatusCode::CONFLICT, "이미 비밀번호가 설정되어 있습니다.")
        }
        _ => internal(),
    }
}

pub(crate) async fn login(headers: HeaderMap, Json(body): Json<LoginRequest>) -> Response {
    if let Some(response) = precheck(&headers) {
        return response;
    }
    match blocking(move || credentials::verify_password(&body.password)).await {
        Some(true) => signed_in(&headers, StatusCode::OK, &serde_json::json!({ "ok": true })),
        Some(false) => failed("비밀번호 불일치."),
        None => internal(),
    }
}

pub(crate) async fn recover(headers: HeaderMap, Json(body): Json<RecoverRequest>) -> Response {
    if let Some(response) = precheck(&headers) {
        return response;
    }
    let result = blocking(move || credentials::recover(&body.recovery_code, &body.password)).await;
    match result {
        Some(Ok(Outcome::Done(code))) => {
            log::warn!("대시보드 비밀번호를 복구 코드로 재설정했습니다");
            signed_in(
                &headers,
                StatusCode::OK,
                &RecoveryView {
                    recovery_code: code,
                },
            )
        }
        Some(Ok(Outcome::Rejected)) => failed("복구 코드 불일치."),
        Some(Ok(Outcome::Invalid(message))) => error(StatusCode::BAD_REQUEST, &message),
        Some(Ok(Outcome::Unavailable)) => {
            error(StatusCode::CONFLICT, "설정된 비밀번호가 없습니다.")
        }
        _ => internal(),
    }
}

pub(crate) async fn logout(headers: HeaderMap) -> Response {
    if headers.get(CSRF_HEADER).and_then(|v| v.to_str().ok()) != Some("1") {
        return error(StatusCode::FORBIDDEN, "요청 형식 오류.");
    }
    auth::logout(&headers);
    let mut response = json(StatusCode::OK, &serde_json::json!({ "ok": true }));
    response
        .headers_mut()
        .insert(SET_COOKIE, session_cookie("", 0, is_https(&headers)));
    response
}

pub(crate) async fn change_password(
    headers: HeaderMap,
    Json(body): Json<ChangeRequest>,
) -> Response {
    if let Some(response) = reject(&headers, true).or_else(locked) {
        return response;
    }
    let result =
        blocking(move || credentials::change_password(&body.current_password, &body.password))
            .await;
    match result {
        Some(Ok(Outcome::Done(()))) => {
            log::info!("대시보드 비밀번호 변경 완료");
            signed_in(&headers, StatusCode::OK, &serde_json::json!({ "ok": true }))
        }
        Some(Ok(Outcome::Rejected)) => failed("현재 비밀번호 불일치."),
        Some(Ok(Outcome::Invalid(message))) => error(StatusCode::BAD_REQUEST, &message),
        _ => internal(),
    }
}

pub(crate) async fn regenerate_recovery(
    headers: HeaderMap,
    Json(body): Json<ConfirmRequest>,
) -> Response {
    if let Some(response) = reject(&headers, true).or_else(locked) {
        return response;
    }
    match blocking(move || credentials::regenerate_recovery(&body.password)).await {
        Some(Ok(Outcome::Done(code))) => {
            auth::record_success();
            log::info!("대시보드 복구 코드 재발급");
            json(
                StatusCode::OK,
                &RecoveryView {
                    recovery_code: code,
                },
            )
        }
        Some(Ok(Outcome::Rejected)) => failed("비밀번호 불일치."),
        _ => internal(),
    }
}

fn precheck(headers: &HeaderMap) -> Option<Response> {
    if headers.get(CSRF_HEADER).and_then(|v| v.to_str().ok()) != Some("1") {
        return Some(error(StatusCode::FORBIDDEN, "요청 형식 오류."));
    }
    if !auth::is_enabled() {
        return Some(error(StatusCode::NOT_FOUND, "대시보드 비활성."));
    }
    locked()
}

fn locked() -> Option<Response> {
    auth::is_locked().then(|| {
        error(
            StatusCode::TOO_MANY_REQUESTS,
            "시도 횟수 초과. 10분 뒤 다시 시도하십시오.",
        )
    })
}

fn failed(message: &str) -> Response {
    auth::record_failure();
    error(StatusCode::FORBIDDEN, message)
}

fn internal() -> Response {
    error(
        StatusCode::INTERNAL_SERVER_ERROR,
        "처리 실패. 봇 로그를 확인하십시오.",
    )
}

fn signed_in<T: Serialize>(headers: &HeaderMap, status: StatusCode, body: &T) -> Response {
    auth::record_success();
    let session = match auth::create_session() {
        Ok(session) => session,
        Err(err) => {
            log::error!("대시보드 세션 생성 실패: {err:#}");
            return internal();
        }
    };
    let mut response = json(status, body);
    response.headers_mut().insert(
        SET_COOKIE,
        session_cookie(&session, auth::SESSION_TTL.as_secs(), is_https(headers)),
    );
    response
}

async fn blocking<T, F>(task: F) -> Option<T>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    tokio::task::spawn_blocking(task).await.ok()
}
