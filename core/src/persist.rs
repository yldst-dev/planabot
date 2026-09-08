use std::io;
use std::path::{Path, PathBuf};

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

fn temp_path(path: &Path) -> PathBuf {
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("state");
    path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()))
}

#[cfg(test)]
mod tests {
    use super::{read_json_or_default, write_json_atomic};
    use serde::{Deserialize, Serialize};

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
