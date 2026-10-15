use anyhow::{Context, Result, anyhow};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShareClaim {
    pub token: String,
    pub gallery_id: String,
    pub title: String,
    pub pages: u32,
    #[serde(default)]
    pub total_pages: u32,
    pub url: String,
    pub path: String,
    pub size: u64,
}

impl ShareClaim {
    pub fn pages_line(&self) -> String {
        if self.total_pages > self.pages {
            format!(
                "{}/{}쪽\n일부 쪽은 받지 못했습니다.",
                self.pages, self.total_pages
            )
        } else {
            format!("{}쪽", self.pages)
        }
    }
}

#[derive(Debug)]
struct ShareFailure {
    code: String,
    message: String,
}

impl std::fmt::Display for ShareFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ShareFailure {}

pub fn failure_notice(err: &anyhow::Error) -> Option<&'static str> {
    match err.downcast_ref::<ShareFailure>()?.code.as_str() {
        "too_large" => Some("불가.\n선생님.\n갤러리가 너무 커서 뷰어를 만들 수 없습니다."),
        "id_mismatch" => Some("불가.\n선생님.\n요청한 번호와 다른 갤러리가 확인되어 중단했습니다."),
        _ => None,
    }
}

#[derive(Debug, Deserialize)]
struct ShareOutput {
    ok: bool,
    token: Option<String>,
    gallery_id: Option<u64>,
    title: Option<String>,
    pages: Option<u32>,
    total_pages: Option<u32>,
    url: Option<String>,
    path: Option<String>,
    size: Option<u64>,
    code: Option<String>,
    error: Option<String>,
}

pub fn hiromi_bin() -> PathBuf {
    std::env::var("HIROMI_BIN")
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("hiromi"))
}

pub async fn share_gallery(bin: &Path, gallery_id: &str) -> Result<ShareClaim> {
    let mut cmd = Command::new(bin);
    cmd.arg("share")
        .arg(gallery_id)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let output = timeout(Duration::from_secs(2 * 60 * 60), cmd.output())
        .await
        .context("hiromi share 시간 초과")?
        .context("hiromi share 실행 실패")?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout
        .lines()
        .rev()
        .find(|line| !line.trim().is_empty())
        .unwrap_or(stdout.as_ref());
    let parsed: ShareOutput = serde_json::from_str(line).with_context(|| {
        let stderr = String::from_utf8_lossy(&output.stderr);
        format!("hiromi share JSON 파싱 실패 stdout={stdout} stderr={stderr}")
    })?;
    if !parsed.ok {
        return Err(ShareFailure {
            code: parsed.code.unwrap_or_default(),
            message: parsed
                .error
                .unwrap_or_else(|| "hiromi share 실패".to_string()),
        }
        .into());
    }
    let token = parsed.token.unwrap_or_default();
    let url = parsed.url.unwrap_or_default();
    let path = parsed.path.unwrap_or_default();
    if token.is_empty() || (url.is_empty() && path.is_empty()) {
        return Err(anyhow!(
            "hiromi share 응답에 token과 url 또는 path가 없습니다"
        ));
    }
    Ok(ShareClaim {
        token,
        gallery_id: parsed
            .gallery_id
            .map(|id| id.to_string())
            .unwrap_or_else(|| gallery_id.to_string()),
        title: parsed.title.unwrap_or_default(),
        pages: parsed.pages.unwrap_or(0),
        total_pages: parsed.total_pages.unwrap_or(0),
        url,
        path,
        size: parsed.size.unwrap_or(0),
    })
}

pub fn start_share_token(text: &str) -> Option<&str> {
    let mut parts = text.split_whitespace();
    let cmd = parts.next()?;
    let name = cmd.split('@').next()?;
    if !name.eq_ignore_ascii_case("/start") {
        return None;
    }
    let payload = parts.next()?;
    payload.strip_prefix("dl_")
}

#[cfg(test)]
mod tests {
    use super::{ShareClaim, ShareOutput, start_share_token};

    #[test]
    fn partial_shares_show_saved_and_total_pages() {
        let claim = |pages, total_pages| ShareClaim {
            pages,
            total_pages,
            ..ShareClaim::default()
        };
        assert_eq!(claim(2, 2).pages_line(), "2쪽");
        assert_eq!(claim(2, 0).pages_line(), "2쪽");
        assert_eq!(
            claim(1, 3).pages_line(),
            "1/3쪽\n일부 쪽은 받지 못했습니다."
        );
    }

    #[test]
    fn parses_ok_share_json() {
        let raw = r#"{"ok":true,"token":"abc","gallery_id":12,"title":"sample","pages":2,"url":"https://send.vis.ee/download/x/#s","size":10}"#;
        let parsed: ShareOutput = serde_json::from_str(raw).unwrap();
        assert!(parsed.ok);
        assert_eq!(parsed.token.as_deref(), Some("abc"));
        assert_eq!(
            parsed.url.as_deref(),
            Some("https://send.vis.ee/download/x/#s")
        );
        assert_eq!(parsed.path, None);
    }

    #[test]
    fn parses_local_share_json() {
        let raw = r#"{"ok":true,"token":"abc","gallery_id":12,"title":"sample","pages":2,"path":"/tmp/shares/abc.html","size":10}"#;
        let parsed: ShareOutput = serde_json::from_str(raw).unwrap();
        assert!(parsed.ok);
        assert_eq!(parsed.path.as_deref(), Some("/tmp/shares/abc.html"));
        assert_eq!(parsed.url, None);
    }

    #[test]
    fn parses_error_share_json() {
        let raw = r#"{"ok":false,"error":"busy"}"#;
        let parsed: ShareOutput = serde_json::from_str(raw).unwrap();
        assert!(!parsed.ok);
        assert_eq!(parsed.error.as_deref(), Some("busy"));
    }

    #[test]
    fn extracts_start_share_token() {
        assert_eq!(start_share_token("/start dl_tok"), Some("tok"));
        assert_eq!(start_share_token("/start@planabot dl_tok"), Some("tok"));
        assert_eq!(start_share_token("/start"), None);
        assert_eq!(start_share_token("dl_tok"), None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn share_gallery_reads_cli_json() {
        use super::share_gallery;
        let dir = std::env::temp_dir().join(format!("hiromi-share-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("hiromi-mock");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho '{\"ok\":true,\"token\":\"tok\",\"gallery_id\":1,\"title\":\"t\",\"pages\":2,\"url\":\"https://send.vis.ee/download/x/#s\",\"size\":9}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let claim = share_gallery(&bin, "1").await.unwrap();
        assert_eq!(claim.token, "tok");
        assert_eq!(claim.url, "https://send.vis.ee/download/x/#s");
        assert!(claim.path.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn share_gallery_reads_local_path() {
        use super::share_gallery;
        let dir = std::env::temp_dir().join(format!("hiromi-share-path-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("hiromi-mock");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho '{\"ok\":true,\"token\":\"tok\",\"gallery_id\":1,\"title\":\"t\",\"pages\":2,\"path\":\"/tmp/shares/tok.html\",\"size\":9}'\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let claim = share_gallery(&bin, "1").await.unwrap();
        assert_eq!(claim.token, "tok");
        assert_eq!(claim.path, "/tmp/shares/tok.html");
        assert!(claim.url.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn share_gallery_keeps_the_failure_code() {
        use super::{failure_notice, share_gallery};
        let dir = std::env::temp_dir().join(format!("hiromi-share-code-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("hiromi-mock");
        std::fs::write(
            &bin,
            "#!/bin/sh\necho '{\"ok\":false,\"code\":\"too_large\",\"error\":\"gallery too large: 3000 pages\"}'\nexit 1\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = share_gallery(&bin, "1").await.unwrap_err();
        assert_eq!(err.to_string(), "gallery too large: 3000 pages");
        assert!(failure_notice(&err).is_some_and(|text| text.contains("너무 커서")));
        assert!(failure_notice(&anyhow::anyhow!("job already running")).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }
}
