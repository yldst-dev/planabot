use anyhow::{Context, Result, anyhow};
use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::time::timeout;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShareClaim {
    pub token: String,
    pub gallery_id: String,
    pub title: String,
    pub pages: u32,
    pub url: String,
    pub path: String,
    pub size: u64,
}

#[derive(Debug, Deserialize)]
struct ShareOutput {
    ok: bool,
    token: Option<String>,
    gallery_id: Option<u64>,
    title: Option<String>,
    pages: Option<u32>,
    url: Option<String>,
    path: Option<String>,
    size: Option<u64>,
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
        return Err(anyhow!(
            parsed
                .error
                .unwrap_or_else(|| "hiromi share 실패".to_string())
        ));
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
    use super::{ShareOutput, start_share_token};

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
}
