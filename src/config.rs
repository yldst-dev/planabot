use std::fs;
use std::path::PathBuf;

use anyhow::{Context, Result, anyhow};
use dotenvy::dotenv;

#[derive(Debug, Clone)]
pub struct Config {
    pub telegram_api_token: String,
}

impl Config {
    pub fn load() -> Result<Self> {
        // .env 있으면 로드 (없어도 오류 아님)
        let _ = dotenv();

        match std::env::var("TELEGRAM_API_TOKEN") {
            Ok(token) if is_valid(&token) => Ok(Self {
                telegram_api_token: token,
            }),
            _ => {
                ensure_env_exists()?;
                Err(anyhow!(
                    "TELEGRAM_API_TOKEN이 설정되어 있지 않습니다. 생성된 .env 파일을 열어 토큰을 입력한 후 다시 실행하세요."
                ))
            }
        }
    }
}

fn is_valid(token: &str) -> bool {
    !token.trim().is_empty() && !token.to_lowercase().contains("your")
}

fn ensure_env_exists() -> Result<()> {
    let env_path = PathBuf::from(".env");

    if !env_path.exists() {
        let template = "TELEGRAM_API_TOKEN=your_token_here\n";
        fs::write(&env_path, template).context(".env 파일을 생성하지 못했습니다")?;
        eprintln!(
            "경고: TELEGRAM_API_TOKEN이 없어 기본 .env 파일을 생성했습니다. .env를 열어 실제 토큰을 입력해 주세요."
        );
    } else {
        eprintln!(
            "경고: TELEGRAM_API_TOKEN이 설정되지 않았습니다. .env 파일에 토큰을 입력해 주세요."
        );
    }

    Ok(())
}
