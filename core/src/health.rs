use axum::{Json, Router, extract::Query, http::StatusCode, routing::get};
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::OnceLock;
use std::time::Instant;

static START_TIME: OnceLock<(Instant, u64)> = OnceLock::new();

#[derive(Deserialize)]
struct HealthQuery {
    secret: Option<String>,
}

#[derive(Serialize)]
struct HealthResponse {
    status: &'static str,
    uptime: u64,
    version: &'static str,
    timestamp: String,
    planabrain_server: bool,
}

async fn health_check(
    Query(query): Query<HealthQuery>,
) -> Result<Json<HealthResponse>, StatusCode> {
    let expected_secret = env::var("HEALTH_SECRET_CORE").ok();

    if let Some(expected) = expected_secret {
        match query.secret {
            Some(provided) if secret_matches(&provided, &expected) => {}
            _ => return Err(StatusCode::UNAUTHORIZED),
        }
    }

    let planabrain_server = crate::planabrain::server::is_ready();
    if !planabrain_server
        && crate::planabrain::is_planabrain_enabled()
        && crate::planabrain::server::is_server_enabled()
    {
        return Err(StatusCode::SERVICE_UNAVAILABLE);
    }

    Ok(Json(HealthResponse {
        status: "ok",
        uptime: uptime_secs(),
        version: env!("CARGO_PKG_VERSION"),
        timestamp: chrono::Utc::now().to_rfc3339(),
        planabrain_server,
    }))
}

fn secret_matches(provided: &str, expected: &str) -> bool {
    provided.len() == expected.len()
        && provided
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |diff, (left, right)| diff | (left ^ right))
            == 0
}

pub fn uptime_secs() -> u64 {
    START_TIME
        .get()
        .map(|(started, _)| started.elapsed().as_secs())
        .unwrap_or(0)
}

pub fn booted_at_ms() -> u64 {
    START_TIME.get().map(|(_, at)| *at).unwrap_or(0)
}

pub fn init_start_time() {
    START_TIME.get_or_init(|| {
        (
            Instant::now(),
            u64::try_from(crate::schedule::now_ms()).unwrap_or(0),
        )
    });
}

pub async fn run_health_server() {
    let port = env::var("HEALTH_PORT").unwrap_or_else(|_| "8080".to_string());
    let addr = format!("0.0.0.0:{}", port);

    let app = Router::new()
        .route("/health", get(health_check))
        .merge(crate::dashboard::router());

    log::info!("헬스체크 서버 시작: {}", addr);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            log::error!("헬스체크 서버 바인드 실패: {}", e);
            return;
        }
    };

    let app = app.into_make_service_with_connect_info::<std::net::SocketAddr>();
    if let Err(e) = axum::serve(listener, app).await {
        log::error!("헬스체크 서버 오류: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::secret_matches;

    #[test]
    fn health_secret_must_match_exactly() {
        assert!(secret_matches("s3cret", "s3cret"));
        assert!(!secret_matches("s3cres", "s3cret"));
        assert!(!secret_matches("s3cre", "s3cret"));
        assert!(!secret_matches("", "s3cret"));
    }
}
