use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

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
    fs::write(&tmp, payload).await?;
    if let Err(err) = fs::rename(&tmp, path).await {
        let _ = fs::remove_file(&tmp).await;
        return Err(err);
    }
    Ok(())
}

pub(crate) fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return T::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
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
    use super::{TempFile, read_json_or_default, write_json_atomic};
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

    #[test]
    fn missing_or_broken_files_fall_back_to_default() {
        let missing = std::env::temp_dir().join("planabot_persist_missing.json");
        assert_eq!(read_json_or_default::<Sample>(&missing), Sample::default());
        let broken = std::env::temp_dir().join(format!(
            "planabot_persist_broken_{}.json",
            std::process::id()
        ));
        std::fs::write(&broken, "{not json").unwrap();
        assert_eq!(read_json_or_default::<Sample>(&broken), Sample::default());
        let _ = std::fs::remove_file(broken);
    }
}
