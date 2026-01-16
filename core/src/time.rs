use chrono::{DateTime, FixedOffset, Utc};
use once_cell::sync::Lazy;
use serde::Deserialize;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const TIME_API_URL: &str = "https://worldtimeapi.org/api/timezone/Asia/Seoul";
const TIME_API_FALLBACK_URL: &str = "https://timeapi.io/api/Time/current/zone?timeZone=Asia/Seoul";
const TIME_API_DATE_HEADER_URL: &str = "https://www.google.com/generate_204";
const TIMEOUT: Duration = Duration::from_secs(2);
const CACHE_TTL: Duration = Duration::from_secs(30);

static TIME_HTTP: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default()
});

static TIME_CACHE: Lazy<Mutex<TimeCache>> = Lazy::new(|| Mutex::new(TimeCache::new()));

#[derive(Debug)]
struct TimeCache {
    last_fetch: Option<Instant>,
    last_time: Option<DateTime<FixedOffset>>,
}

impl TimeCache {
    fn new() -> Self {
        Self {
            last_fetch: None,
            last_time: None,
        }
    }
}

#[derive(Debug, Deserialize)]
struct WorldTimeApiResponse {
    datetime: String,
}

#[derive(Debug, Deserialize)]
struct TimeApiResponse {
    #[serde(rename = "dateTime")]
    date_time: String,
}

pub async fn kst_now() -> DateTime<FixedOffset> {
    let now = Instant::now();
    if let Some(cached) = read_cached_time(now).await {
        return cached;
    }

    match fetch_kst_time().await {
        Ok(kst) => {
            write_cached_time(now, kst).await;
            kst
        }
        Err(err) => {
            log::warn!("인터넷 시각 조회 실패: {:?}", err);
            fallback_kst()
        }
    }
}

async fn read_cached_time(now: Instant) -> Option<DateTime<FixedOffset>> {
    let guard = TIME_CACHE.lock().await;
    let last_fetch = guard.last_fetch?;
    let last_time = guard.last_time?;
    if now.duration_since(last_fetch) > CACHE_TTL {
        return None;
    }
    let elapsed = now.duration_since(last_fetch);
    let elapsed = chrono::Duration::from_std(elapsed).ok()?;
    Some(last_time + elapsed)
}

async fn write_cached_time(now: Instant, time: DateTime<FixedOffset>) {
    let mut guard = TIME_CACHE.lock().await;
    guard.last_fetch = Some(now);
    guard.last_time = Some(time);
}

async fn fetch_kst_time() -> anyhow::Result<DateTime<FixedOffset>> {
    if let Ok(time) = fetch_from_worldtimeapi().await {
        return Ok(time);
    }
    if let Ok(time) = fetch_from_timeapi().await {
        return Ok(time);
    }
    if let Ok(time) = fetch_from_date_header(TIME_API_DATE_HEADER_URL).await {
        return Ok(time);
    }
    anyhow::bail!("all internet time providers failed")
}

async fn fetch_from_worldtimeapi() -> anyhow::Result<DateTime<FixedOffset>> {
    let response = TIME_HTTP
        .get(TIME_API_URL)
        .send()
        .await?
        .error_for_status()?;
    let payload: WorldTimeApiResponse = response.json().await?;
    let parsed = DateTime::parse_from_rfc3339(&payload.datetime)?;
    Ok(parsed)
}

async fn fetch_from_timeapi() -> anyhow::Result<DateTime<FixedOffset>> {
    let response = TIME_HTTP
        .get(TIME_API_FALLBACK_URL)
        .send()
        .await?
        .error_for_status()?;
    let payload: TimeApiResponse = response.json().await?;
    let parsed = DateTime::parse_from_rfc3339(&payload.date_time)?;
    Ok(parsed)
}

async fn fetch_from_date_header(url: &str) -> anyhow::Result<DateTime<FixedOffset>> {
    let response = TIME_HTTP.get(url).send().await?.error_for_status()?;
    let header = response
        .headers()
        .get(reqwest::header::DATE)
        .ok_or_else(|| anyhow::anyhow!("missing Date header"))?;
    let raw = header.to_str()?;
    let parsed = DateTime::parse_from_rfc2822(raw)?;
    let offset = FixedOffset::east_opt(9 * 3600).expect("KST offset should be valid");
    Ok(parsed.with_timezone(&offset))
}

fn fallback_kst() -> DateTime<FixedOffset> {
    let offset = FixedOffset::east_opt(9 * 3600).expect("KST offset should be valid");
    Utc::now().with_timezone(&offset)
}
