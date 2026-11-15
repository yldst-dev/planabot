use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use log::error;
use serde::Serialize;
use serde::de::DeserializeOwned;
use tokio::fs;

pub(crate) async fn write_json_atomic<T: Serialize + ?Sized>(
    path: &Path,
    value: &T,
) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let payload = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    let tmp = temp_path(path);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    private_mode(&mut options);
    fs::OpenOptions::from(options).open(&tmp).await?;
    fs::write(&tmp, payload).await?;
    if let Err(err) = fs::rename(&tmp, path).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(err);
    }
    Ok(())
}

pub(crate) fn write_private(path: &Path, contents: &[u8]) -> io::Result<()> {
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    private_mode(&mut options);
    options.open(path)?.write_all(contents)
}

pub(crate) fn state_path(key: &str, default: &str) -> PathBuf {
    let path = PathBuf::from(std::env::var(key).unwrap_or_else(|_| default.to_string()));
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

pub(crate) fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    let raw = match std::fs::read(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return T::default(),
        Err(err) => {
            error!(
                "상태 파일을 읽지 못해 빈 값으로 시작합니다: {} ({err})",
                path.display()
            );
            return T::default();
        }
    };
    serde_json::from_slice(&raw).unwrap_or_else(|err| {
        error!(
            "상태 파일을 해석하지 못해 빈 값으로 시작합니다: {} (JSON 해석 실패 {}행 {}열)",
            path.display(),
            err.line(),
            err.column()
        );
        keep_corrupt_copy(path, &raw);
        T::default()
    })
}

fn keep_corrupt_copy(path: &Path, raw: &[u8]) {
    let Some(mut name) = path.file_name().map(|name| name.to_os_string()) else {
        return;
    };
    name.push(".corrupt");
    let backup = path.with_file_name(name);
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    private_mode(&mut options);
    let result = options.open(&backup).and_then(|mut file| {
        file.write_all(raw).inspect_err(|_| {
            let _ = std::fs::remove_file(&backup);
        })
    });
    match result {
        Ok(()) => error!("손상된 상태 파일을 보관했습니다: {}", backup.display()),
        Err(err) if err.kind() == io::ErrorKind::AlreadyExists => error!(
            "보관본이 이미 있어 이번 손상 내용은 보관하지 않습니다: {}",
            backup.display()
        ),
        Err(err) => error!(
            "손상된 상태 파일을 보관하지 못했습니다: {} ({err})",
            backup.display()
        ),
    }
}

pub(crate) fn read_json_strict<T: DeserializeOwned + Default>(path: &Path) -> io::Result<T> {
    let raw = match std::fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(T::default()),
        Err(err) => return Err(err),
    };
    serde_json::from_str(&raw).map_err(|err| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("JSON 해석 실패 {}행 {}열", err.line(), err.column()),
        )
    })
}

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) struct TempFile(PathBuf);

impl TempFile {
    pub(crate) fn create(prefix: &str, contents: &[u8]) -> io::Result<Self> {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|elapsed| elapsed.as_nanos())
            .unwrap_or(0);
        let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "{prefix}_{}_{nanos}_{sequence}.tmp",
            std::process::id()
        ));
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        private_mode(&mut options);
        let mut file = options.open(&path)?;
        let temp = Self(path);
        file.write_all(contents)?;
        Ok(temp)
    }

    pub(crate) fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

#[cfg(unix)]
fn private_mode(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
}

#[cfg(not(unix))]
fn private_mode(_options: &mut std::fs::OpenOptions) {}

fn temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state");
    path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::{TempFile, read_json_or_default, read_json_strict, write_json_atomic};
    use serde::{Deserialize, Serialize};

    #[test]
    fn temp_files_are_private_unique_and_removed_on_drop() {
        let first = TempFile::create("planabot_persist_temp", b"secret").expect("first");
        let second = TempFile::create("planabot_persist_temp", b"secret").expect("second");
        assert_ne!(first.path(), second.path());
        assert_eq!(std::fs::read(first.path()).unwrap(), b"secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(first.path())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let path = first.path().to_path_buf();
        drop(first);
        assert!(!path.exists());
    }

    #[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
    struct Sample {
        items: Vec<u32>,
    }

    #[tokio::test]
    async fn writes_then_reads_back_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("planabot_persist_{}", std::process::id()));
        let path = dir.join("nested").join("sample.json");
        let value = Sample {
            items: vec![1, 2, 3],
        };
        write_json_atomic(&path, &value).await.expect("write");
        assert_eq!(read_json_or_default::<Sample>(&path), value);
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn state_files_are_private_from_the_moment_they_exist() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("planabot_private_{}", std::process::id()));
        let path = dir.join("secret.json");
        write_json_atomic(&path, &Sample::default())
            .await
            .expect("async write");
        let plain = dir.join("plain.json");
        super::write_private(&plain, b"{}").expect("sync write");
        for file in [&path, &plain] {
            let mode = std::fs::metadata(file).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    fn fresh_dir(name: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("planabot_persist_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn backups(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut found: Vec<_> = std::fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .filter(|path| path.extension().is_some_and(|ext| ext == "corrupt"))
            .collect();
        found.sort();
        found
    }

    #[test]
    fn missing_or_broken_files_fall_back_to_default() {
        let dir = fresh_dir("fallback");
        assert_eq!(
            read_json_or_default::<Sample>(&dir.join("missing.json")),
            Sample::default()
        );
        let broken = dir.join("broken.json");
        std::fs::write(&broken, "{not json").unwrap();
        assert_eq!(read_json_or_default::<Sample>(&broken), Sample::default());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn corrupt_file_keeps_exactly_one_private_backup_of_the_original_bytes() {
        let dir = fresh_dir("backup_once");
        let path = dir.join("state.json");
        let original = br#"{"items": [1, 2, "secret-value"#;
        std::fs::write(&path, original).unwrap();
        assert_eq!(read_json_or_default::<Sample>(&path), Sample::default());
        let found = backups(&dir);
        assert_eq!(found, [dir.join("state.json.corrupt")]);
        assert_eq!(std::fs::read(&found[0]).unwrap(), original);
        assert_eq!(std::fs::read(&path).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&found[0]).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_second_corrupt_read_never_overwrites_the_earliest_backup() {
        let dir = fresh_dir("backup_earliest");
        let path = dir.join("state.json");
        std::fs::write(&path, "{first").unwrap();
        read_json_or_default::<Sample>(&path);
        std::fs::write(&path, "{second").unwrap();
        read_json_or_default::<Sample>(&path);
        assert_eq!(
            std::fs::read(dir.join("state.json.corrupt")).unwrap(),
            b"{first"
        );
        assert_eq!(backups(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn non_utf8_and_wrong_shape_files_are_backed_up_too() {
        let dir = fresh_dir("backup_shapes");
        let binary = dir.join("binary.json");
        std::fs::write(&binary, [0xff, 0xfe, 0x00]).unwrap();
        let wrong = dir.join("wrong.json");
        std::fs::write(&wrong, r#"{"items": "text"}"#).unwrap();
        for path in [&binary, &wrong] {
            assert_eq!(read_json_or_default::<Sample>(path), Sample::default());
        }
        assert_eq!(
            std::fs::read(dir.join("binary.json.corrupt")).unwrap(),
            [0xff, 0xfe, 0x00]
        );
        assert_eq!(
            std::fs::read(dir.join("wrong.json.corrupt")).unwrap(),
            br#"{"items": "text"}"#
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn missing_and_valid_files_leave_no_backup() {
        let dir = fresh_dir("backup_none");
        read_json_or_default::<Sample>(&dir.join("missing.json"));
        let valid = dir.join("valid.json");
        std::fs::write(&valid, r#"{"items": [4]}"#).unwrap();
        assert_eq!(
            read_json_or_default::<Sample>(&valid),
            Sample { items: vec![4] }
        );
        assert!(backups(&dir).is_empty());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn strict_reader_defaults_only_for_missing_files() {
        let missing = std::env::temp_dir().join("planabot_persist_strict_missing.json");
        assert_eq!(
            read_json_strict::<Sample>(&missing).unwrap(),
            Sample::default()
        );
        let broken = std::env::temp_dir().join(format!(
            "planabot_persist_strict_broken_{}.json",
            std::process::id()
        ));
        std::fs::write(&broken, r#"{"items": "secret-value"}"#).unwrap();
        let err = read_json_strict::<Sample>(&broken).expect_err("broken");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
        assert!(!err.to_string().contains("secret-value"));
        let dir = std::env::temp_dir();
        assert!(read_json_strict::<Sample>(&dir).is_err());
        let _ = std::fs::remove_file(broken);
    }
}
