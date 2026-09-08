use std::process::Stdio;
use std::sync::RwLock;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use log::{error, info, warn};
use once_cell::sync::Lazy;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};

use super::{
    PlanabrainError, apply_dotenv_path, build_planabrain_command, find_planabrain_root,
    is_planabrain_enabled,
};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const RESTART_MIN_BACKOFF: Duration = Duration::from_secs(2);
const RESTART_MAX_BACKOFF: Duration = Duration::from_secs(60);
const TOKEN_HEADER: &str = "x-planabrain-token";

#[derive(Clone, Debug)]
struct ServerEndpoint {
    base_url: String,
    token: String,
}

static ENDPOINT: Lazy<RwLock<Option<ServerEndpoint>>> = Lazy::new(|| RwLock::new(None));
static HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap_or_default()
});

#[derive(Debug, Deserialize)]
struct ReadyLine {
    ready: bool,
    port: u16,
}

#[derive(Debug, Deserialize)]
struct ErrorEnvelope {
    error: PlanabrainError,
}

pub(crate) fn is_server_enabled() -> bool {
    match std::env::var("PLANABOT_PLANABRAIN_SERVER") {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        Err(_) => true,
    }
}

pub(crate) fn is_ready() -> bool {
    current_endpoint().is_some()
}

pub(crate) fn spawn_supervisor() {
    if !is_planabrain_enabled() || !is_server_enabled() {
        info!("planabrain 상주 서버를 사용하지 않습니다");
        return;
    }
    tokio::spawn(async move {
        let mut backoff = RESTART_MIN_BACKOFF;
        loop {
            match launch().await {
                Ok((mut child, stdin)) => {
                    backoff = RESTART_MIN_BACKOFF;
                    let status = child.wait().await;
                    drop(stdin);
                    clear_endpoint();
                    warn!("planabrain 서버가 종료되었습니다: {:?}", status);
                }
                Err(err) => {
                    clear_endpoint();
                    error!("planabrain 서버 시작 실패: {:#}", err);
                }
            }
            tokio::time::sleep(backoff).await;
            backoff = (backoff * 2).min(RESTART_MAX_BACKOFF);
        }
    });
}

async fn launch() -> Result<(Child, ChildStdin)> {
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let token = generate_token();
    let mut command = build_planabrain_command(&root)?;
    command
        .current_dir(&root)
        .arg("serve")
        .env("PLANABRAIN_SERVER_TOKEN", &token);
    apply_dotenv_path(&mut command, &root);
    let mut command = TokioCommand::from(command);
    command
        .kill_on_drop(true)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    let mut child = command.spawn().context("planabrain 서버 실행 실패")?;
    let stdin = child
        .stdin
        .take()
        .context("planabrain 서버 stdin을 열지 못했습니다")?;
    let stdout = child
        .stdout
        .take()
        .context("planabrain 서버 stdout을 열지 못했습니다")?;
    let mut lines = BufReader::new(stdout).lines();

    let ready = tokio::time::timeout(READY_TIMEOUT, async {
        loop {
            match lines.next_line().await? {
                Some(line) => {
                    if let Some(ready) = parse_ready_line(&line) {
                        return Ok::<ReadyLine, anyhow::Error>(ready);
                    }
                    info!("planabrain 서버: {}", line);
                }
                None => return Err(anyhow!("준비 신호 전에 planabrain 서버가 종료되었습니다")),
            }
        }
    })
    .await
    .context("planabrain 서버 준비 신호 대기 시간 초과")??;

    tokio::spawn(async move {
        while let Ok(Some(line)) = lines.next_line().await {
            info!("planabrain 서버: {}", line);
        }
    });

    set_endpoint(ServerEndpoint {
        base_url: format!("http://127.0.0.1:{}", ready.port),
        token,
    });
    info!("planabrain 서버 준비 완료: 포트 {}", ready.port);
    Ok((child, stdin))
}

fn parse_ready_line(line: &str) -> Option<ReadyLine> {
    let parsed: ReadyLine = serde_json::from_str(line.trim()).ok()?;
    parsed.ready.then_some(parsed)
}

fn generate_token() -> String {
    use std::hash::{BuildHasher, Hasher};
    let mut token = String::with_capacity(64);
    for round in 0..4u64 {
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u64(std::process::id() as u64 ^ round);
        token.push_str(&format!("{:016x}", hasher.finish()));
    }
    token
}

fn current_endpoint() -> Option<ServerEndpoint> {
    ENDPOINT.read().ok().and_then(|guard| guard.clone())
}

fn set_endpoint(endpoint: ServerEndpoint) {
    if let Ok(mut guard) = ENDPOINT.write() {
        *guard = Some(endpoint);
    }
}

fn clear_endpoint() {
    if let Ok(mut guard) = ENDPOINT.write() {
        *guard = None;
    }
}

pub(crate) async fn post_json<T, R>(path: &str, body: &T, timeout: Duration) -> Result<Option<R>>
where
    T: Serialize + ?Sized,
    R: DeserializeOwned,
{
    let Some(endpoint) = current_endpoint() else {
        return Ok(None);
    };
    let url = format!("{}{}", endpoint.base_url, path);
    let response = match HTTP
        .post(&url)
        .header(TOKEN_HEADER, &endpoint.token)
        .timeout(timeout)
        .json(body)
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) if err.is_connect() => {
            warn!("planabrain 서버에 연결하지 못해 CLI로 대체합니다: {}", err);
            return Ok(None);
        }
        Err(err) if err.is_timeout() => {
            return Err(anyhow!(
                "planabrain 서버 {} 시간 초과 ({}초)",
                path,
                timeout.as_secs()
            ));
        }
        Err(err) => return Err(anyhow!("planabrain 서버 요청 실패: {}", err)),
    };
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .context("planabrain 서버 응답을 읽지 못했습니다")?;
    if status.is_success() {
        return serde_json::from_slice(&bytes)
            .map(Some)
            .context("planabrain 서버 응답 파싱 실패");
    }
    if let Ok(envelope) = serde_json::from_slice::<ErrorEnvelope>(&bytes) {
        return Err(anyhow::Error::new(envelope.error));
    }
    Err(anyhow!(
        "planabrain 서버 오류 ({}): {}",
        status,
        String::from_utf8_lossy(&bytes).trim()
    ))
}

#[cfg(test)]
mod tests {
    use super::{ServerEndpoint, clear_endpoint, parse_ready_line, post_json, set_endpoint};
    use crate::planabrain::PlanabrainErrorKind;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[tokio::test]
    #[ignore]
    async fn server_roundtrip_against_real_cli() {
        let (child, stdin) = super::launch().await.expect("launch");
        let input = crate::planabrain::TurnPrepareInput {
            user_id: "server_test_user".into(),
            chat_scope: "chat_server_test".into(),
            conversation_id: None,
            question: "10분 타이머 맞춰줘".into(),
            memory_query_text: "10분 타이머 맞춰줘".into(),
            now_ms: 1_788_800_000_000,
            memory_enabled: false,
            token_budget: None,
        };
        let started = std::time::Instant::now();
        let output: Option<crate::planabrain::TurnPrepareOutput> =
            post_json("/v1/turn-prepare", &input, Duration::from_secs(30))
                .await
                .expect("post");
        let output = output.expect("server answered");
        eprintln!(
            "roundtrip: {:?} in {:?}",
            output.schedule,
            started.elapsed()
        );
        assert!(
            output
                .schedule
                .map(|schedule| schedule.handled)
                .unwrap_or(false)
        );
        drop(stdin);
        drop(child);
        clear_endpoint();
    }

    #[test]
    fn ready_line_requires_ready_flag_and_port() {
        assert_eq!(
            parse_ready_line(r#"{"ready":true,"port":4321}"#).map(|r| r.port),
            Some(4321)
        );
        assert!(parse_ready_line(r#"{"ready":false,"port":1}"#).is_none());
        assert!(parse_ready_line("starting up").is_none());
    }

    async fn serve_once(status_line: &'static str, body: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let _ = socket.read(&mut buf).await;
            let response = format!(
                "HTTP/1.1 {status_line}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = socket.write_all(response.as_bytes()).await;
        });
        port
    }

    #[tokio::test]
    async fn post_json_returns_none_without_endpoint_and_parses_success_and_errors() {
        clear_endpoint();
        let none: Option<serde_json::Value> =
            post_json("/v1/x", &serde_json::json!({}), Duration::from_secs(1))
                .await
                .unwrap();
        assert!(none.is_none());

        let port = serve_once("200 OK", r#"{"answer":"hi"}"#).await;
        set_endpoint(ServerEndpoint {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "t".into(),
        });
        let ok: Option<serde_json::Value> = post_json(
            "/v1/ask",
            &serde_json::json!({"q": 1}),
            Duration::from_secs(5),
        )
        .await
        .unwrap();
        assert_eq!(ok.unwrap()["answer"], "hi");

        let port = serve_once(
            "500 Internal Server Error",
            r#"{"error":{"kind":"rate_limited","provider":"OpenRouter","status":429,"message":"slow down","retryable":true}}"#,
        )
        .await;
        set_endpoint(ServerEndpoint {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "t".into(),
        });
        let err = post_json::<_, serde_json::Value>(
            "/v1/ask",
            &serde_json::json!({}),
            Duration::from_secs(5),
        )
        .await
        .expect_err("error expected");
        let structured = err
            .downcast_ref::<crate::planabrain::PlanabrainError>()
            .expect("structured");
        assert_eq!(structured.kind, PlanabrainErrorKind::RateLimited);
        assert_eq!(structured.status, Some(429));
        clear_endpoint();
    }
}
