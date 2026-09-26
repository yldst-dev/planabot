use std::num::NonZeroU32;

use anyhow::{Result, anyhow};
use ring::pbkdf2;
use ring::rand::{SecureRandom, SystemRandom};
use serde::{Deserialize, Serialize};

const ALGORITHM: pbkdf2::Algorithm = pbkdf2::PBKDF2_HMAC_SHA256;
const HASH_LEN: usize = 32;
const SALT_LEN: usize = 16;
const CODE_ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

#[cfg(not(test))]
pub(crate) const PASSWORD_ITERATIONS: u32 = 600_000;
#[cfg(test)]
pub(crate) const PASSWORD_ITERATIONS: u32 = 1_000;
pub(crate) const CODE_ITERATIONS: u32 = 10_000;

pub(crate) const MIN_PASSWORD_CHARS: usize = 8;
pub(crate) const MAX_PASSWORD_BYTES: usize = 256;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Hashed {
    pub salt: String,
    pub hash: String,
    pub iterations: u32,
}

pub(crate) fn random_bytes<const N: usize>() -> Result<[u8; N]> {
    let mut bytes = [0u8; N];
    SystemRandom::new()
        .fill(&mut bytes)
        .map_err(|_| anyhow!("난수 생성 실패"))?;
    Ok(bytes)
}

pub(crate) fn random_hex<const N: usize>() -> Result<String> {
    Ok(to_hex(&random_bytes::<N>()?))
}

pub(crate) fn hash(secret: &str, iterations: u32) -> Result<Hashed> {
    let salt = random_bytes::<SALT_LEN>()?;
    let rounds = NonZeroU32::new(iterations).ok_or_else(|| anyhow!("반복 횟수 오류"))?;
    let mut out = [0u8; HASH_LEN];
    pbkdf2::derive(ALGORITHM, rounds, &salt, secret.as_bytes(), &mut out);
    Ok(Hashed {
        salt: to_hex(&salt),
        hash: to_hex(&out),
        iterations,
    })
}

pub(crate) fn verify(secret: &str, hashed: &Hashed) -> bool {
    let (Some(salt), Some(expected), Some(rounds)) = (
        from_hex(&hashed.salt),
        from_hex(&hashed.hash),
        NonZeroU32::new(hashed.iterations),
    ) else {
        return false;
    };
    pbkdf2::verify(ALGORITHM, rounds, &salt, secret.as_bytes(), &expected).is_ok()
}

pub(crate) fn generate_code(groups: usize) -> Result<String> {
    let bytes = random_bytes::<32>()?;
    let chars: Vec<char> = bytes
        .iter()
        .take(groups * 4)
        .map(|byte| CODE_ALPHABET[usize::from(*byte) % CODE_ALPHABET.len()] as char)
        .collect();
    Ok(chars
        .chunks(4)
        .map(|chunk| chunk.iter().collect::<String>())
        .collect::<Vec<_>>()
        .join("-"))
}

pub(crate) fn normalize_code(raw: &str) -> String {
    raw.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_uppercase())
        .collect()
}

pub(crate) fn validate_new_password(password: &str) -> Result<()> {
    if password.chars().count() < MIN_PASSWORD_CHARS {
        return Err(anyhow!(
            "비밀번호는 {MIN_PASSWORD_CHARS}자 이상이어야 합니다."
        ));
    }
    if password.len() > MAX_PASSWORD_BYTES {
        return Err(anyhow!("비밀번호가 너무 깁니다."));
    }
    if password.trim() != password {
        return Err(anyhow!("비밀번호 앞뒤에 공백을 둘 수 없습니다."));
    }
    Ok(())
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(raw: &str) -> Option<Vec<u8>> {
    raw.as_bytes()
        .chunks(2)
        .map(|pair| match pair {
            [high, low] => Some((hex_digit(*high)? << 4) | hex_digit(*low)?),
            _ => None,
        })
        .collect()
}

fn hex_digit(byte: u8) -> Option<u8> {
    char::from(byte)
        .to_digit(16)
        .and_then(|digit| u8::try_from(digit).ok())
}

#[cfg(test)]
mod tests {
    use super::{
        Hashed, generate_code, hash, normalize_code, random_hex, validate_new_password, verify,
    };

    #[test]
    fn hashes_verify_only_the_original_secret() {
        let hashed = hash("correct horse", 1_000).unwrap();
        assert!(verify("correct horse", &hashed));
        assert!(!verify("correct horse ", &hashed));
        assert!(!verify("wrong", &hashed));
    }

    #[test]
    fn same_secret_gets_different_salts() {
        let first = hash("secret-value", 1_000).unwrap();
        let second = hash("secret-value", 1_000).unwrap();
        assert_ne!(first.salt, second.salt);
        assert_ne!(first.hash, second.hash);
    }

    #[test]
    fn broken_hash_records_never_verify() {
        let broken = Hashed {
            salt: "zz".into(),
            hash: "abc".into(),
            iterations: 1,
        };
        assert!(!verify("anything", &broken));
        let zero = Hashed {
            iterations: 0,
            ..hash("x", 1_000).unwrap()
        };
        assert!(!verify("x", &zero));
    }

    #[test]
    fn codes_are_grouped_and_normalize_back() {
        let code = generate_code(4).unwrap();
        assert_eq!(code.len(), 19);
        assert_eq!(code.matches('-').count(), 3);
        assert_eq!(normalize_code(&code.to_lowercase()), code.replace('-', ""));
        assert_eq!(normalize_code(" ab-cd 12 "), "ABCD12");
        assert_eq!(random_hex::<32>().unwrap().len(), 64);
    }

    #[test]
    fn password_rules() {
        assert!(validate_new_password("short").is_err());
        assert!(validate_new_password(" leading-space").is_err());
        assert!(validate_new_password(&"a".repeat(300)).is_err());
        assert!(validate_new_password("프라나비밀번호12").is_ok());
    }
}
