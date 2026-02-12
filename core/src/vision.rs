use anyhow::{Context, Result, anyhow};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use once_cell::sync::Lazy;
use reqwest::Client;
use serde_json::Value;
use std::time::Duration;

#[allow(dead_code)]
static CLIENT: Lazy<Client> = Lazy::new(|| {
    Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .expect("reqwest client should build")
});

#[allow(dead_code)]
pub(crate) async fn describe_image(bytes: &[u8], mime_type: &str, prompt: &str) -> Result<String> {
    let api_key =
        std::env::var("GOOGLE_API_KEY").context("GOOGLE_API_KEY가 설정되어 있지 않습니다")?;
    let model =
        std::env::var("PLANABRAIN_GEMINI_MODEL").unwrap_or_else(|_| "gemini-1.5-flash".to_string());
    let max_output_tokens = resolve_max_output_tokens()?;

    let encoded = STANDARD.encode(bytes);
    let url = format!(
        "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={api_key}"
    );
    let mut body = serde_json::json!({
        "contents": [
            {
                "role": "user",
                "parts": [
                    { "text": prompt },
                    { "inline_data": { "mime_type": mime_type, "data": encoded } }
                ]
            }
        ]
    });

    if let Some(max_output_tokens) = max_output_tokens {
        body["generationConfig"] = serde_json::json!({
            "maxOutputTokens": max_output_tokens,
        });
    }

    let response = CLIENT
        .post(url)
        .json(&body)
        .send()
        .await
        .context("이미지 분석 요청 실패")?;

    if !response.status().is_success() {
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        return Err(anyhow!(
            "이미지 분석 실패: 상태 코드 {}, 상세: {}",
            status,
            detail
        ));
    }

    let payload: Value = response
        .json()
        .await
        .context("이미지 분석 응답 파싱 실패")?;
    let text = payload["candidates"][0]["content"]["parts"][0]["text"]
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("이미지 분석 결과가 비어 있습니다"))?;

    Ok(text.to_string())
}

fn resolve_max_output_tokens() -> Result<Option<u32>> {
    const DEFAULT_VISION_MAX_OUTPUT_TOKENS: u32 = 512;

    if let Some(value) = parse_env_max_output_tokens("PLANABRAIN_GEMINI_VISION_MAX_OUTPUT_TOKENS")?
    {
        return Ok(value);
    }

    if let Some(value) = parse_env_max_output_tokens("PLANABRAIN_GEMINI_MAX_OUTPUT_TOKENS")? {
        return Ok(value);
    }

    Ok(Some(DEFAULT_VISION_MAX_OUTPUT_TOKENS))
}

fn parse_env_max_output_tokens(key: &str) -> Result<Option<Option<u32>>> {
    let Ok(raw) = std::env::var(key) else {
        return Ok(None);
    };
    let trimmed = raw.trim();

    if trimmed.is_empty() || trimmed == "0" || trimmed.eq_ignore_ascii_case("false") {
        return Ok(Some(None));
    }

    let value = trimmed
        .parse::<u32>()
        .map_err(|_| anyhow!("{key} must be a positive integer (or 0 to disable)"))?;
    if value == 0 {
        return Ok(Some(None));
    }
    Ok(Some(Some(value)))
}
