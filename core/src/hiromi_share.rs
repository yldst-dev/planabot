use anyhow::{Context, Result, anyhow};
use log::{info, warn};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, SystemTime};
use tokio::process::Command;
use tokio::sync::OnceCell;
use tokio::time::timeout;

const STALE_GALLERY_AGE: Duration = Duration::from_secs(60 * 60);
static STALE_GALLERIES_SWEPT: OnceCell<()> = OnceCell::const_new();

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

fn download_dir_from(explicit: Option<&str>, cwd: &Path) -> PathBuf {
    let value = explicit
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("downloads");
    cwd.join(value)
}

fn download_dir() -> PathBuf {
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    download_dir_from(std::env::var("HIROMI_DOWNLOAD_DIR").ok().as_deref(), &cwd)
}

fn remove_stale_galleries(dir: &Path, max_age: Duration, now: SystemTime) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let mut removed = 0;
    for entry in entries.flatten() {
        let is_gallery_name = entry
            .file_name()
            .to_str()
            .is_some_and(|name| !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()));
        let is_real_dir = entry.file_type().is_ok_and(|kind| kind.is_dir());
        let is_stale = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| now.duration_since(modified).ok())
            .is_some_and(|age| age >= max_age);
        if !(is_gallery_name && is_real_dir && is_stale) {
            continue;
        }
        match std::fs::remove_dir_all(entry.path()) {
            Ok(()) => removed += 1,
            Err(err) => warn!("남은 갤러리 폴더 삭제 실패: {}", err),
        }
    }
    removed
}

async fn sweep_stale_galleries_once(dir: PathBuf) {
    let removed = tokio::task::spawn_blocking(move || {
        remove_stale_galleries(&dir, STALE_GALLERY_AGE, SystemTime::now())
    })
    .await
    .unwrap_or(0);
    if removed > 0 {
        info!("남은 갤러리 폴더 {}개를 정리했습니다.", removed);
    }
}

pub async fn share_gallery(bin: &Path, gallery_id: &str) -> Result<ShareClaim> {
    let dir = download_dir();
    STALE_GALLERIES_SWEPT
        .get_or_init(|| sweep_stale_galleries_once(dir.clone()))
        .await;
    share_gallery_in(bin, gallery_id, &dir).await
}

async fn share_gallery_in(bin: &Path, gallery_id: &str, download_dir: &Path) -> Result<ShareClaim> {
    let mut cmd = Command::new(bin);
    cmd.arg("share")
        .arg(gallery_id)
        .env("HIROMI_DOWNLOAD_DIR", download_dir)
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
    use super::{
        ShareClaim, ShareOutput, download_dir_from, remove_stale_galleries, start_share_token,
    };
    use std::path::{Path, PathBuf};
    use std::time::{Duration, SystemTime};

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
        use super::share_gallery_in;
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
        let claim = share_gallery_in(&bin, "1", &dir).await.unwrap();
        assert_eq!(claim.token, "tok");
        assert_eq!(claim.url, "https://send.vis.ee/download/x/#s");
        assert!(claim.path.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn share_gallery_reads_local_path() {
        use super::share_gallery_in;
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
        let claim = share_gallery_in(&bin, "1", &dir).await.unwrap();
        assert_eq!(claim.token, "tok");
        assert_eq!(claim.path, "/tmp/shares/tok.html");
        assert!(claim.url.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn share_gallery_keeps_the_failure_code() {
        use super::{failure_notice, share_gallery_in};
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
        let err = share_gallery_in(&bin, "1", &dir).await.unwrap_err();
        assert_eq!(err.to_string(), "gallery too large: 3000 pages");
        assert!(failure_notice(&err).is_some_and(|text| text.contains("너무 커서")));
        assert!(failure_notice(&anyhow::anyhow!("job already running")).is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn share_gallery_hands_the_download_dir_to_hiromi() {
        use super::share_gallery_in;
        let dir = std::env::temp_dir().join(format!("hiromi-share-dir-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let bin = dir.join("hiromi-mock");
        std::fs::write(
            &bin,
            "#!/bin/sh\nprintf '{\"ok\":true,\"token\":\"tok\",\"title\":\"%s\",\"url\":\"https://send.vis.ee/download/x/#s\"}\\n' \"$HIROMI_DOWNLOAD_DIR\"\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        let downloads = dir.join("downloads");
        let claim = share_gallery_in(&bin, "1", &downloads).await.unwrap();
        assert_eq!(claim.title, downloads.to_string_lossy());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn download_dir_matches_where_hiromi_writes() {
        let cwd = Path::new("/app");
        assert_eq!(
            download_dir_from(None, cwd),
            PathBuf::from("/app/downloads")
        );
        assert_eq!(
            download_dir_from(Some("  "), cwd),
            PathBuf::from("/app/downloads")
        );
        assert_eq!(
            download_dir_from(Some("/tmp/hiromi-downloads"), cwd),
            PathBuf::from("/tmp/hiromi-downloads")
        );
        assert_eq!(
            download_dir_from(Some(" saved "), cwd),
            PathBuf::from("/app/saved")
        );
    }

    fn sweep_fixture(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("hiromi-sweep-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn only_old_gallery_folders_are_removed_and_the_staged_viewers_stay() {
        let root = sweep_fixture("old");
        let downloads = root.join("dl");
        for gallery in ["123", "456"] {
            std::fs::create_dir_all(downloads.join(gallery)).unwrap();
            std::fs::write(downloads.join(gallery).join("001.webp"), b"page").unwrap();
        }
        std::fs::create_dir_all(downloads.join("shares")).unwrap();
        std::fs::write(downloads.join("shares/tok.html"), b"viewer").unwrap();
        std::fs::create_dir_all(downloads.join("notes")).unwrap();
        std::fs::write(downloads.join("789"), b"file named like a gallery").unwrap();
        std::fs::write(root.join("outside.txt"), b"keep").unwrap();
        let hour = Duration::from_secs(60 * 60);
        let now = SystemTime::now();

        assert_eq!(remove_stale_galleries(&downloads, hour, now), 0);
        assert!(downloads.join("123/001.webp").exists());

        let later = now + Duration::from_secs(2 * 60 * 60);
        assert_eq!(remove_stale_galleries(&downloads, hour, later), 2);
        assert!(!downloads.join("123").exists());
        assert!(!downloads.join("456").exists());
        assert!(downloads.join("shares/tok.html").exists());
        assert!(downloads.join("notes").exists());
        assert!(downloads.join("789").is_file());
        assert!(downloads.exists());
        assert_eq!(std::fs::read(root.join("outside.txt")).unwrap(), b"keep");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_gallery_folder_is_not_followed() {
        let root = sweep_fixture("link");
        let downloads = root.join("dl");
        let outside = root.join("outside");
        std::fs::create_dir_all(&downloads).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("keep.txt"), b"keep").unwrap();
        std::os::unix::fs::symlink(&outside, downloads.join("999")).unwrap();
        let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);

        assert_eq!(
            remove_stale_galleries(&downloads, Duration::from_secs(60 * 60), later),
            0
        );
        assert_eq!(std::fs::read(outside.join("keep.txt")).unwrap(), b"keep");
        assert!(downloads.join("999").is_symlink());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn a_missing_download_dir_is_left_alone() {
        let root = sweep_fixture("missing");
        let downloads = root.join("never-created");
        let later = SystemTime::now() + Duration::from_secs(2 * 60 * 60);

        assert_eq!(
            remove_stale_galleries(&downloads, Duration::from_secs(60 * 60), later),
            0
        );
        assert!(!downloads.exists());
        let _ = std::fs::remove_dir_all(root);
    }
}
