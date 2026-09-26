use axum::{Json, Router, extract::Query, http::StatusCode, routing::get};
use serde::{Deserialize, Serialize};
use std::env;
use std::sync::OnceLock;
use std::time::Instant;

static START_TIME: OnceLock<Instant> = OnceLock::new();

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
            Some(provided) if provided == expected => {}
            _ => return Err(StatusCode::UNAUTHORIZED),
        }
    }

    Ok(Json(HealthResponse {
        status: "ok",
        uptime: uptime_secs(),
        version: env!("CARGO_PKG_VERSION"),
        timestamp: chrono::Utc::now().to_rfc3339(),
        planabrain_server: crate::planabrain::server::is_ready(),
    }))
}

pub fn uptime_secs() -> u64 {
    START_TIME.get().map(|s| s.elapsed().as_secs()).unwrap_or(0)
}

pub fn init_start_time() {
    START_TIME.get_or_init(Instant::now);
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

    if let Err(e) = axum::serve(listener, app).await {
        log::error!("헬스체크 서버 오류: {}", e);
    }
}
