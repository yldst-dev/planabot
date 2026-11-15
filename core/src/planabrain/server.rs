use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{LazyLock, Mutex, RwLock};
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use log::{error, info, warn};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command as TokioCommand};
use tokio::sync::Notify;
use tokio::task::JoinHandle;

use super::{
    PlanabrainError, apply_dotenv_path, build_planabrain_command, find_planabrain_root,
    is_planabrain_enabled,
};

const READY_TIMEOUT: Duration = Duration::from_secs(30);
const RESTART_MIN_BACKOFF: Duration = Duration::from_secs(2);
const RESTART_MAX_BACKOFF: Duration = Duration::from_secs(60);
const STOP_WAIT: Duration = Duration::from_secs(20);
const HEALTH_INTERVAL: Duration = Duration::from_secs(20);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(10);
const HEALTH_MAX_FAILURES: u32 = 3;
const TOKEN_HEADER: &str = "x-planabrain-token";

#[derive(Clone, Debug)]
struct ServerEndpoint {
    base_url: String,
    token: String,
}

static ENDPOINT: LazyLock<RwLock<Option<ServerEndpoint>>> = LazyLock::new(|| RwLock::new(None));
static STOP: Notify = Notify::const_new();
static STOPPING: AtomicBool = AtomicBool::new(false);
static SUPERVISOR: Mutex<Option<JoinHandle<()>>> = Mutex::new(None);
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .no_proxy()
        .pool_idle_timeout(Duration::from_secs(4))
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
    let supervisor = tokio::spawn(async move {
        let mut backoff = RESTART_MIN_BACKOFF;
        loop {
            match launch().await {
                Ok((mut child, stdin, endpoint)) => {
                    backoff = RESTART_MIN_BACKOFF;
                    let status = tokio::select! {
                        status = child.wait() => status,
                        () = STOP.notified() => {
                            clear_endpoint();
                            let status = close_and_wait(&mut child, stdin).await;
                            info!("planabrain 서버 종료: {:?}", status);
                            return;
                        }
                        () = watch_health(&endpoint, HEALTH_INTERVAL, HEALTH_TIMEOUT, is_stopping) => {
                            clear_endpoint();
                            warn!(
                                "planabrain 서버가 상태 확인에 {}번 연속 응답하지 않아 다시 시작합니다",
                                HEALTH_MAX_FAILURES
                            );
                            let _ = child.kill().await;
                            child.wait().await
                        }
                    };
                    drop(stdin);
                    clear_endpoint();
                    warn!("planabrain 서버가 종료되었습니다: {:?}", status);
                }
                Err(err) => {
                    clear_endpoint();
                    error!("planabrain 서버 시작 실패: {:#}", err);
                }
            }
            if tokio::time::timeout(backoff, STOP.notified()).await.is_ok() {
                return;
            }
            backoff = (backoff * 2).min(RESTART_MAX_BACKOFF);
        }
    });
    if let Ok(mut slot) = SUPERVISOR.lock() {
        *slot = Some(supervisor);
    }
}

pub(crate) async fn stop() {
    STOPPING.store(true, Ordering::SeqCst);
    STOP.notify_one();
    let supervisor = SUPERVISOR.lock().ok().and_then(|mut slot| slot.take());
    let Some(supervisor) = supervisor else {
        return;
    };
    if tokio::time::timeout(STOP_WAIT, supervisor).await.is_err() {
        warn!(
            "planabrain 서버가 {}초 안에 끝나지 않아 강제로 종료합니다",
            STOP_WAIT.as_secs()
        );
    }
}

fn is_stopping() -> bool {
    STOPPING.load(Ordering::SeqCst) || crate::bot::is_shutting_down()
}

async fn watch_health(
    endpoint: &ServerEndpoint,
    interval: Duration,
    timeout: Duration,
    stopping: fn() -> bool,
) {
    let url = format!("{}/v1/health", endpoint.base_url);
    let mut failures = 0;
    loop {
        tokio::time::sleep(interval).await;
        if stopping() {
            failures = 0;
            continue;
        }
        let reason = match HTTP
            .get(&url)
            .header(TOKEN_HEADER, &endpoint.token)
            .timeout(timeout)
            .send()
            .await
        {
            Ok(_) => {
                failures = 0;
                continue;
            }
            Err(err) if err.is_timeout() => format!("{}초 안에 응답 없음", timeout.as_secs_f32()),
            Err(err) => err.to_string(),
        };
        failures += 1;
        warn!(
            "planabrain 서버 상태 확인 실패 ({}/{}): {}",
            failures, HEALTH_MAX_FAILURES, reason
        );
        if failures >= HEALTH_MAX_FAILURES && !stopping() {
            return;
        }
    }
}

fn own_process_group(command: &mut std::process::Command) {
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(command, 0);
    #[cfg(not(unix))]
    let _ = command;
}

async fn close_and_wait(child: &mut Child, stdin: ChildStdin) -> std::io::Result<ExitStatus> {
    drop(stdin);
    child.wait().await
}

async fn launch() -> Result<(Child, ChildStdin, ServerEndpoint)> {
    let root = find_planabrain_root().context("planabrain 디렉터리를 찾지 못했습니다")?;
    let token = generate_token();
    let mut command = build_planabrain_command(&root)?;
    command
        .current_dir(&root)
        .arg("serve")
        .env("PLANABRAIN_SERVER_TOKEN", &token);
    apply_dotenv_path(&mut command, &root);
    own_process_group(&mut command);
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

    let endpoint = ServerEndpoint {
        base_url: format!("http://127.0.0.1:{}", ready.port),
        token,
    };
    set_endpoint(endpoint.clone());
    info!("planabrain 서버 준비 완료: 포트 {}", ready.port);
    Ok((child, stdin, endpoint))
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
        let (child, stdin, _) = super::launch().await.expect("launch");
        let input = crate::planabrain::TurnPrepareInput {
            request_id: "server-test-request".into(),
            deadline_ms: crate::schedule::now_ms() + 60_000,
            user_id: "server_test_user".into(),
            chat_scope: "chat_server_test".into(),
            conversation_id: None,
            question: "10분 타이머 맞춰줘".into(),
            memory_query_text: "10분 타이머 맞춰줘".into(),
            now_ms: 1_788_800_000_000,
            memory_enabled: false,
            token_budget: None,
            has_image: false,
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

    #[tokio::test]
    async fn closing_stdin_lets_the_server_finish_before_it_exits() {
        let marker = std::env::temp_dir().join(format!("planabrain-stop-{}", std::process::id()));
        let _ = std::fs::remove_file(&marker);
        let mut child = tokio::process::Command::new("sh")
            .args(["-c", "cat >/dev/null; sleep 0.3; echo done > \"$1\"", "sh"])
            .arg(&marker)
            .stdin(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn");
        let stdin = child.stdin.take().expect("stdin");
        let status = tokio::time::timeout(
            Duration::from_secs(5),
            super::close_and_wait(&mut child, stdin),
        )
        .await
        .expect("exits after stdin closes")
        .expect("wait");
        assert!(status.success());
        assert_eq!(
            std::fs::read_to_string(&marker).unwrap_or_default(),
            "done\n"
        );
        let _ = std::fs::remove_file(&marker);
    }

    #[tokio::test]
    async fn a_child_started_like_the_server_leads_its_own_process_group() {
        let probe = |own_group: bool| {
            let mut command = std::process::Command::new("sh");
            command.args(["-c", "kill -0 -$$"]);
            if own_group {
                super::own_process_group(&mut command);
            }
            tokio::process::Command::from(command).status()
        };
        assert!(probe(true).await.expect("spawn").success());
        assert!(!probe(false).await.expect("spawn").success());
    }

    async fn health_server(script: fn(usize) -> &'static str) -> ServerEndpoint {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let mut held = Vec::new();
            for index in 0.. {
                let Ok((mut socket, _)) = listener.accept().await else {
                    return;
                };
                let step = script(index);
                if step == "hang" {
                    held.push(socket);
                    continue;
                }
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let _ = socket.read(&mut buf).await;
                    if step == "slow" {
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                    let body = r#"{"ok":true}"#;
                    let response = format!(
                        "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = socket.write_all(response.as_bytes()).await;
                });
            }
        });
        ServerEndpoint {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "t".into(),
        }
    }

    async fn restarts_within(
        script: fn(usize) -> &'static str,
        stopping: fn() -> bool,
        window: Duration,
    ) -> bool {
        let endpoint = health_server(script).await;
        tokio::time::timeout(
            window,
            super::watch_health(
                &endpoint,
                Duration::from_millis(20),
                Duration::from_millis(400),
                stopping,
            ),
        )
        .await
        .is_ok()
    }

    #[tokio::test]
    async fn a_slow_but_answering_server_is_not_restarted() {
        assert!(!restarts_within(|_| "slow", || false, Duration::from_millis(1500)).await);
    }

    #[tokio::test]
    async fn a_server_that_never_answers_is_restarted_after_three_failures() {
        let started = std::time::Instant::now();
        assert!(restarts_within(|_| "hang", || false, Duration::from_secs(5)).await);
        assert!(started.elapsed() >= Duration::from_millis(1200));
    }

    #[tokio::test]
    async fn a_server_that_recovers_on_the_second_poll_is_not_restarted() {
        assert!(
            !restarts_within(
                |index| if index == 0 { "hang" } else { "ok" },
                || false,
                Duration::from_millis(1500)
            )
            .await
        );
    }

    #[tokio::test]
    async fn a_success_resets_the_failure_count() {
        assert!(
            !restarts_within(
                |index| if matches!(index, 0 | 1 | 3 | 4) {
                    "hang"
                } else {
                    "ok"
                },
                || false,
                Duration::from_millis(2500)
            )
            .await
        );
    }

    #[tokio::test]
    async fn a_hung_server_is_not_restarted_while_core_is_stopping() {
        assert!(!restarts_within(|_| "hang", || true, Duration::from_millis(1500)).await);
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

        let port = serve_once(
            "200 OK",
            r#"{"handled":true,"action":"add","kind":"timer","title":"알림","dueAtMs":1788800600000}"#,
        )
        .await;
        set_endpoint(ServerEndpoint {
            base_url: format!("http://127.0.0.1:{port}"),
            token: "t".into(),
        });
        let schedule = crate::planabrain::interpret_schedule_request("10분 뒤 알림")
            .await
            .expect("served schedule");
        assert_eq!(schedule.due_at_ms, Some(1_788_800_600_000));

        for todo in [false, true] {
            let port = serve_once(
                "500 Internal Server Error",
                r#"{"error":{"kind":"unknown","message":"boom"}}"#,
            )
            .await;
            set_endpoint(ServerEndpoint {
                base_url: format!("http://127.0.0.1:{port}"),
                token: "t".into(),
            });
            let failed = if todo {
                crate::planabrain::list_user_todos("1").await.map(|_| ())
            } else {
                crate::planabrain::interpret_schedule_request("10분 뒤 알림")
                    .await
                    .map(|_| ())
            };
            assert!(
                failed.is_err(),
                "server error must not rerun through the CLI"
            );
        }
        clear_endpoint();
    }
}
