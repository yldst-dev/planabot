use chrono::{DateTime, FixedOffset, Utc};
use serde::Deserialize;
use std::sync::LazyLock;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

const TIME_API_URL: &str = "https://worldtimeapi.org/api/timezone/Asia/Seoul";
const TIME_API_FALLBACK_URL: &str = "https://timeapi.io/api/Time/current/zone?timeZone=Asia/Seoul";
const TIME_API_DATE_HEADER_URL: &str = "https://www.google.com/generate_204";
const TIMEOUT: Duration = Duration::from_secs(2);
const CACHE_TTL: Duration = Duration::from_secs(30);
const FAILURE_TTL: Duration = Duration::from_secs(15);

static TIME_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(TIMEOUT)
        .build()
        .unwrap_or_default()
});

static TIME_CACHE: LazyLock<Mutex<TimeCache>> = LazyLock::new(|| Mutex::new(TimeCache::new()));

#[derive(Debug)]
struct TimeCache {
    last_fetch: Option<Instant>,
    last_time: Option<DateTime<FixedOffset>>,
    failed_until: Option<Instant>,
}

impl TimeCache {
    fn new() -> Self {
        Self {
            last_fetch: None,
            last_time: None,
            failed_until: None,
        }
    }

    fn read(&self, now: Instant) -> Option<DateTime<FixedOffset>> {
        let elapsed = now.duration_since(self.last_fetch?);
        if elapsed > CACHE_TTL {
            return None;
        }
        Some(self.last_time? + chrono::Duration::from_std(elapsed).ok()?)
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
    cached_or_fetch(&TIME_CACHE, fetch_kst_time).await
}

async fn cached_or_fetch<F, Fut>(cache: &Mutex<TimeCache>, fetch: F) -> DateTime<FixedOffset>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = anyhow::Result<DateTime<FixedOffset>>>,
{
    let now = Instant::now();
    {
        let guard = cache.lock().await;
        if let Some(cached) = guard.read(now) {
            return cached;
        }
        if guard.failed_until.is_some_and(|until| now < until) {
            return fallback_kst();
        }
    }

    match fetch().await {
        Ok(kst) => {
            let mut guard = cache.lock().await;
            guard.last_fetch = Some(now);
            guard.last_time = Some(kst);
            kst
        }
        Err(err) => {
            log::warn!("인터넷 시각 조회 실패: {:?}", err);
            cache.lock().await.failed_until = Some(Instant::now() + FAILURE_TTL);
            fallback_kst()
        }
    }
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

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    async fn lookup(cache: &Mutex<TimeCache>, calls: &AtomicUsize, works: bool) {
        cached_or_fetch(cache, || async {
            calls.fetch_add(1, Ordering::SeqCst);
            if works {
                Ok(fallback_kst())
            } else {
                anyhow::bail!("offline")
            }
        })
        .await;
    }

    #[tokio::test]
    async fn a_failed_lookup_is_not_retried_inside_the_failure_window() {
        let cache = Mutex::new(TimeCache::new());
        let calls = AtomicUsize::new(0);
        for _ in 0..5 {
            lookup(&cache, &calls, false).await;
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_lookup_is_retried_once_the_failure_window_has_passed() {
        let cache = Mutex::new(TimeCache::new());
        let calls = AtomicUsize::new(0);
        lookup(&cache, &calls, false).await;
        cache.lock().await.failed_until = Some(Instant::now());
        lookup(&cache, &calls, true).await;
        lookup(&cache, &calls, true).await;
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn a_failed_lookup_still_answers_with_the_local_clock() {
        let cache = Mutex::new(TimeCache::new());
        let answer = cached_or_fetch(&cache, || async { anyhow::bail!("offline") }).await;
        assert!(
            (Utc::now() - answer.with_timezone(&Utc))
                .num_seconds()
                .abs()
                <= 1
        );
    }
}
