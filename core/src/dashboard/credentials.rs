use std::path::{Path, PathBuf};
use std::sync::Mutex;

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

use super::password::{
    self, CODE_ITERATIONS, Hashed, PASSWORD_ITERATIONS, generate_code, normalize_code,
};
use crate::persist::read_json_or_default;

const SETUP_CODE_GROUPS: usize = 3;
const RECOVERY_CODE_GROUPS: usize = 5;

static LOCK: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct CredentialFile {
    #[serde(default)]
    password: Option<Hashed>,
    #[serde(default)]
    recovery: Option<Hashed>,
    #[serde(default)]
    setup: Option<Hashed>,
    #[serde(default)]
    credential_id: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum Outcome<T> {
    Done(T),
    Rejected,
    Invalid(String),
    Unavailable,
}

pub(crate) fn path() -> PathBuf {
    super::store::state_path().with_file_name("dashboard-auth.json")
}

pub(crate) fn is_configured() -> bool {
    load(&path()).password.is_some()
}

pub(crate) fn credential_id() -> String {
    load(&path()).credential_id
}

pub(crate) fn rotate_setup_code() -> Result<Option<String>> {
    rotate_setup_code_at(&path())
}

pub(crate) fn ensure_setup_code() -> Result<Option<String>> {
    let path = path();
    let file = load(&path);
    if file.password.is_some() || file.setup.is_some() {
        return Ok(None);
    }
    rotate_setup_code_at(&path)
}

pub(crate) fn setup(code: &str, new_password: &str) -> Result<Outcome<String>> {
    setup_at(&path(), code, new_password)
}

pub(crate) fn verify_password(candidate: &str) -> bool {
    verify_password_at(&path(), candidate)
}

pub(crate) fn recover(code: &str, new_password: &str) -> Result<Outcome<String>> {
    recover_at(&path(), code, new_password)
}

pub(crate) fn change_password(current: &str, new_password: &str) -> Result<Outcome<()>> {
    change_password_at(&path(), current, new_password)
}

pub(crate) fn regenerate_recovery(current: &str) -> Result<Outcome<String>> {
    regenerate_recovery_at(&path(), current)
}

pub(crate) fn reset() -> Result<String> {
    reset_at(&path())
}

fn rotate_setup_code_at(path: &Path) -> Result<Option<String>> {
    let _guard = lock();
    let mut file = load(path);
    if file.password.is_some() {
        return Ok(None);
    }
    let code = generate_code(SETUP_CODE_GROUPS)?;
    file.setup = Some(password::hash(&normalize_code(&code), CODE_ITERATIONS)?);
    save(path, &file)?;
    Ok(Some(code))
}

fn setup_at(path: &Path, code: &str, new_password: &str) -> Result<Outcome<String>> {
    if let Err(err) = password::validate_new_password(new_password) {
        return Ok(Outcome::Invalid(err.to_string()));
    }
    let _guard = lock();
    let mut file = load(path);
    if file.password.is_some() {
        return Ok(Outcome::Unavailable);
    }
    let accepted = file
        .setup
        .as_ref()
        .is_some_and(|setup| password::verify(&normalize_code(code), setup));
    if !accepted {
        return Ok(Outcome::Rejected);
    }
    let recovery = issue(&mut file, new_password)?;
    file.setup = None;
    save(path, &file)?;
    Ok(Outcome::Done(recovery))
}

fn verify_password_at(path: &Path, candidate: &str) -> bool {
    load(path)
        .password
        .as_ref()
        .is_some_and(|hashed| password::verify(candidate, hashed))
}

fn recover_at(path: &Path, code: &str, new_password: &str) -> Result<Outcome<String>> {
    if let Err(err) = password::validate_new_password(new_password) {
        return Ok(Outcome::Invalid(err.to_string()));
    }
    let _guard = lock();
    let mut file = load(path);
    if file.password.is_none() {
        return Ok(Outcome::Unavailable);
    }
    let accepted = file
        .recovery
        .as_ref()
        .is_some_and(|recovery| password::verify(&normalize_code(code), recovery));
    if !accepted {
        return Ok(Outcome::Rejected);
    }
    let recovery = issue(&mut file, new_password)?;
    save(path, &file)?;
    Ok(Outcome::Done(recovery))
}

fn change_password_at(path: &Path, current: &str, new_password: &str) -> Result<Outcome<()>> {
    if let Err(err) = password::validate_new_password(new_password) {
        return Ok(Outcome::Invalid(err.to_string()));
    }
    let _guard = lock();
    let mut file = load(path);
    let Some(hashed) = file.password.as_ref() else {
        return Ok(Outcome::Unavailable);
    };
    if !password::verify(current, hashed) {
        return Ok(Outcome::Rejected);
    }
    file.password = Some(password::hash(new_password, PASSWORD_ITERATIONS)?);
    file.credential_id = password::random_hex::<16>()?;
    save(path, &file)?;
    Ok(Outcome::Done(()))
}

fn regenerate_recovery_at(path: &Path, current: &str) -> Result<Outcome<String>> {
    let _guard = lock();
    let mut file = load(path);
    let Some(hashed) = file.password.as_ref() else {
        return Ok(Outcome::Unavailable);
    };
    if !password::verify(current, hashed) {
        return Ok(Outcome::Rejected);
    }
    let code = generate_code(RECOVERY_CODE_GROUPS)?;
    file.recovery = Some(password::hash(&normalize_code(&code), CODE_ITERATIONS)?);
    save(path, &file)?;
    Ok(Outcome::Done(code))
}

fn reset_at(path: &Path) -> Result<String> {
    let _guard = lock();
    let code = generate_code(SETUP_CODE_GROUPS)?;
    let file = CredentialFile {
        password: None,
        recovery: None,
        setup: Some(password::hash(&normalize_code(&code), CODE_ITERATIONS)?),
        credential_id: password::random_hex::<16>()?,
    };
    save(path, &file)?;
    Ok(code)
}

fn issue(file: &mut CredentialFile, new_password: &str) -> Result<String> {
    let recovery = generate_code(RECOVERY_CODE_GROUPS)?;
    file.password = Some(password::hash(new_password, PASSWORD_ITERATIONS)?);
    file.recovery = Some(password::hash(&normalize_code(&recovery), CODE_ITERATIONS)?);
    file.credential_id = password::random_hex::<16>()?;
    Ok(recovery)
}

fn lock() -> std::sync::MutexGuard<'static, ()> {
    LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn load(path: &Path) -> CredentialFile {
    read_json_or_default(path)
}

fn save(path: &Path, file: &CredentialFile) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).context("인증 파일 폴더를 만들지 못했습니다")?;
    }
    let payload = serde_json::to_string_pretty(file)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, payload).context("인증 파일을 쓰지 못했습니다")?;
    super::auth::restrict_permissions(&tmp);
    std::fs::rename(&tmp, path).context("인증 파일을 교체하지 못했습니다")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        Outcome, change_password_at, load, recover_at, regenerate_recovery_at, reset_at,
        rotate_setup_code_at, setup_at, verify_password_at,
    };
    use std::path::PathBuf;

    fn temp_file(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "planabot_credentials_{name}_{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("dashboard-auth.json")
    }

    #[test]
    fn first_setup_requires_the_logged_code() {
        let path = temp_file("setup");
        let code = rotate_setup_code_at(&path).unwrap().unwrap();
        assert_eq!(
            setup_at(&path, "AAAA-BBBB-CCCC", "long-enough-pw").unwrap(),
            Outcome::Rejected
        );
        assert!(matches!(
            setup_at(&path, &code, "short").unwrap(),
            Outcome::Invalid(_)
        ));
        let Outcome::Done(recovery) =
            setup_at(&path, &code.to_lowercase(), "long-enough-pw").unwrap()
        else {
            panic!("setup should succeed");
        };
        assert_eq!(recovery.len(), 24);
        assert!(load(&path).setup.is_none());
        assert!(verify_password_at(&path, "long-enough-pw"));
        assert!(!verify_password_at(&path, "long-enough-pX"));
        assert_eq!(
            setup_at(&path, &code, "another-password").unwrap(),
            Outcome::Unavailable
        );
        assert_eq!(rotate_setup_code_at(&path).unwrap(), None);
    }

    #[test]
    fn recovery_code_resets_password_once_and_rotates() {
        let path = temp_file("recover");
        let code = rotate_setup_code_at(&path).unwrap().unwrap();
        let Outcome::Done(recovery) = setup_at(&path, &code, "first-password").unwrap() else {
            panic!("setup should succeed");
        };
        let before = load(&path).credential_id;
        assert_eq!(
            recover_at(&path, "WRONG-CODE", "second-password").unwrap(),
            Outcome::Rejected
        );
        let Outcome::Done(next) = recover_at(&path, &recovery, "second-password").unwrap() else {
            panic!("recovery should succeed");
        };
        assert_ne!(next, recovery);
        assert_ne!(load(&path).credential_id, before);
        assert!(verify_password_at(&path, "second-password"));
        assert_eq!(
            recover_at(&path, &recovery, "third-password").unwrap(),
            Outcome::Rejected
        );
    }

    #[test]
    fn change_and_regenerate_require_current_password() {
        let path = temp_file("change");
        let code = rotate_setup_code_at(&path).unwrap().unwrap();
        setup_at(&path, &code, "first-password").unwrap();
        assert_eq!(
            change_password_at(&path, "nope-nope", "second-password").unwrap(),
            Outcome::Rejected
        );
        assert_eq!(
            change_password_at(&path, "first-password", "second-password").unwrap(),
            Outcome::Done(())
        );
        assert_eq!(
            regenerate_recovery_at(&path, "first-password").unwrap(),
            Outcome::Rejected
        );
        assert!(matches!(
            regenerate_recovery_at(&path, "second-password").unwrap(),
            Outcome::Done(_)
        ));
    }

    #[test]
    fn reset_clears_password_and_issues_setup_code() {
        let path = temp_file("reset");
        let code = rotate_setup_code_at(&path).unwrap().unwrap();
        setup_at(&path, &code, "first-password").unwrap();
        let fresh = reset_at(&path).unwrap();
        assert!(!verify_password_at(&path, "first-password"));
        assert!(matches!(
            setup_at(&path, &fresh, "brand-new-password").unwrap(),
            Outcome::Done(_)
        ));
    }
}
