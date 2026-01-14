use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use log::{info, warn};
use once_cell::sync::Lazy;
use reqwest::StatusCode;
use reqwest::header::RETRY_AFTER;
use serde::Deserialize;
use url::Url;

use super::link_utils::{MusicLink, MusicPlatform};
use super::webshare::{WebshareConfig, WebshareProxy, fetch_webshare_proxies};

const ODESLI_ENDPOINT: &str = "https://api.song.link/v1-alpha.1/links";
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(6);

static MUSIC_HTTP: Lazy<MusicHttp> = Lazy::new(MusicHttp::new);

#[derive(Debug, Clone)]
pub struct ResolvedMusicLink {
    pub original: String,
    pub cleaned: String,
    pub platform: MusicPlatform,
    pub platform_links: HashMap<MusicPlatform, String>,
}

#[derive(Debug, Deserialize)]
struct OdesliResponse {
    #[serde(rename = "linksByPlatform")]
    links_by_platform: HashMap<String, OdesliPlatformLink>,
}

#[derive(Debug, Deserialize)]
struct OdesliPlatformLink {
    url: String,
}

pub struct MusicHttp {
    direct: reqwest::Client,
    proxies: Arc<Mutex<Vec<ProxyState>>>,
    next: AtomicUsize,
    has_proxy_config: bool,
    allow_direct_fallback: bool,
}

struct ProxyState {
    client: reqwest::Client,
    label: String,
    rate_limited_until: Option<Instant>,
}

struct ProxySelection {
    client: reqwest::Client,
    index: usize,
}

impl MusicHttp {
    fn new() -> Self {
        let direct = build_client(None).unwrap_or_default();
        let proxies = Arc::new(Mutex::new(Vec::new()));
        let webshare_config = WebshareConfig::from_env();
        let has_proxy_config = webshare_config.is_some();
        let allow_direct_fallback = parse_bool_env("SONGLINK_DIRECT_FALLBACK");

        if let Some(config) = webshare_config {
            let proxies_ref = Arc::clone(&proxies);
            let direct_ref = direct.clone();
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn(async move {
                    let loaded = load_proxy_states(&direct_ref, &config).await;
                    if loaded.is_empty() {
                        if allow_direct_fallback {
                            warn!(
                                "Webshare 프록시가 유효하지 않아 direct fallback으로 진행합니다."
                            );
                        } else {
                            warn!("Webshare 프록시가 유효하지 않아 song.link 매핑을 생략합니다.");
                        }
                    } else {
                        info!(
                            "Webshare 프록시 {}개 확인 완료. 음악 링크 매핑에 프록시를 사용합니다.",
                            loaded.len()
                        );
                    }
                    if let Ok(mut guard) = proxies_ref.lock() {
                        *guard = loaded;
                    }
                });
            } else {
                warn!("Tokio 런타임이 없어 Webshare 프록시 로드를 건너뜁니다.");
            }
        }

        Self {
            direct,
            proxies,
            next: AtomicUsize::new(0),
            has_proxy_config,
            allow_direct_fallback,
        }
    }

    fn next_proxy(&self) -> Option<ProxySelection> {
        let mut proxies = self.proxies.lock().ok()?;
        if proxies.is_empty() {
            return None;
        }

        let now = Instant::now();
        let start = self.next.fetch_add(1, Ordering::Relaxed);
        let len = proxies.len();

        for offset in 0..len {
            let idx = (start + offset) % len;
            let state = &mut proxies[idx];
            if let Some(until) = state.rate_limited_until {
                if until > now {
                    continue;
                }
                state.rate_limited_until = None;
            }

            return Some(ProxySelection {
                client: state.client.clone(),
                index: idx,
            });
        }

        None
    }

    fn mark_rate_limited(&self, index: usize, retry_after: Duration) {
        let mut proxies = match self.proxies.lock() {
            Ok(guard) => guard,
            Err(_) => return,
        };
        if let Some(state) = proxies.get_mut(index) {
            state.rate_limited_until = Some(Instant::now() + retry_after);
            warn!(
                "프록시 {}는 {:?} 동안 rate limit으로 비활성 처리합니다.",
                state.label, retry_after
            );
        }
    }

    fn proxy_count(&self) -> usize {
        self.proxies.lock().map(|guard| guard.len()).unwrap_or(0)
    }
}

pub fn music_http() -> &'static MusicHttp {
    &MUSIC_HTTP
}

pub async fn resolve_music_links(http: &MusicHttp, links: &[MusicLink]) -> Vec<ResolvedMusicLink> {
    let mut resolved = Vec::with_capacity(links.len());
    let mut cache: HashMap<String, HashMap<MusicPlatform, String>> = HashMap::new();

    for link in links {
        let platform_links = if let Some(cached) = cache.get(&link.cleaned) {
            cached.clone()
        } else {
            let fetched = fetch_platform_links(http, &link.cleaned)
                .await
                .unwrap_or_default();
            cache.insert(link.cleaned.clone(), fetched.clone());
            fetched
        };

        resolved.push(ResolvedMusicLink {
            original: link.original.clone(),
            cleaned: link.cleaned.clone(),
            platform: link.platform,
            platform_links,
        });
    }

    resolved
}

async fn fetch_platform_links(
    http: &MusicHttp,
    cleaned_url: &str,
) -> Option<HashMap<MusicPlatform, String>> {
    let mut api_url = Url::parse(ODESLI_ENDPOINT).ok()?;
    api_url.query_pairs_mut().append_pair("url", cleaned_url);

    if !http.has_proxy_config {
        return request_platform_links(&http.direct, &api_url).await.ok();
    }

    let proxy_count = http.proxy_count();
    let mut attempts = 0;
    let max_attempts = if proxy_count > 0 { proxy_count } else { 0 };

    while attempts < max_attempts {
        attempts += 1;
        let selection = match http.next_proxy() {
            Some(selection) => selection,
            None => break,
        };

        let client = selection.client;
        match request_platform_links(&client, &api_url).await {
            Ok(mapped) => return Some(mapped),
            Err(RequestFailure::RateLimited(retry_after)) => {
                http.mark_rate_limited(selection.index, retry_after);
            }
            Err(RequestFailure::Other) => {
                continue;
            }
        }
    }

    if http.allow_direct_fallback {
        return request_platform_links(&http.direct, &api_url).await.ok();
    }

    None
}

fn platform_from_key(key: &str) -> Option<MusicPlatform> {
    match key {
        "spotify" => Some(MusicPlatform::Spotify),
        "youtubeMusic" => Some(MusicPlatform::YouTubeMusic),
        "youtube" => Some(MusicPlatform::YouTube),
        "appleMusic" => Some(MusicPlatform::AppleMusic),
        _ => None,
    }
}

fn build_client(proxy: Option<&WebshareProxy>) -> Option<reqwest::Client> {
    let mut builder = reqwest::Client::builder().timeout(DEFAULT_TIMEOUT);

    if let Some(proxy) = proxy {
        let proxy_url = proxy.to_url();
        let proxy = reqwest::Proxy::all(&proxy_url).ok()?;
        builder = builder.proxy(proxy);
    }

    builder.build().ok()
}

async fn load_proxy_states(direct: &reqwest::Client, config: &WebshareConfig) -> Vec<ProxyState> {
    let proxies = fetch_webshare_proxies(direct, config).await;
    let mut states = Vec::new();
    for proxy in proxies {
        let Some(client) = build_client(Some(&proxy)) else {
            continue;
        };
        match probe_proxy(&client).await {
            ProbeResult::Ok => states.push(ProxyState {
                client,
                label: format!("{}:{}", proxy.host, proxy.port),
                rate_limited_until: None,
            }),
            ProbeResult::RateLimited(retry_after) => states.push(ProxyState {
                client,
                label: format!("{}:{}", proxy.host, proxy.port),
                rate_limited_until: Some(Instant::now() + retry_after),
            }),
            ProbeResult::Failed => {}
        }
    }
    states
}

enum ProbeResult {
    Ok,
    RateLimited(Duration),
    Failed,
}

async fn probe_proxy(client: &reqwest::Client) -> ProbeResult {
    let mut url = match Url::parse(ODESLI_ENDPOINT) {
        Ok(url) => url,
        Err(err) => {
            warn!("음악 링크 매핑 URL 파싱 실패: {:?}", err);
            return ProbeResult::Failed;
        }
    };
    url.query_pairs_mut().append_pair(
        "url",
        "https://open.spotify.com/track/1FYWnRofuIgJf62AnX8i5S",
    );

    match client.get(url).send().await {
        Ok(response) => {
            if response.status().is_success() {
                return ProbeResult::Ok;
            }
            if response.status() == StatusCode::TOO_MANY_REQUESTS {
                let retry_after = parse_retry_after(&response).unwrap_or(Duration::from_secs(60));
                return ProbeResult::RateLimited(retry_after);
            }
            warn!("프록시 연결 테스트 실패: 상태 코드 {}", response.status());
            ProbeResult::Failed
        }
        Err(err) => {
            warn!("프록시 연결 테스트 실패: {:?}", err);
            ProbeResult::Failed
        }
    }
}

enum RequestFailure {
    RateLimited(Duration),
    Other,
}

async fn request_platform_links(
    client: &reqwest::Client,
    api_url: &Url,
) -> Result<HashMap<MusicPlatform, String>, RequestFailure> {
    let response = match client.get(api_url.clone()).send().await {
        Ok(response) => response,
        Err(err) => {
            warn!("음악 링크 매핑 요청 실패: {:?}", err);
            return Err(RequestFailure::Other);
        }
    };

    if response.status() == StatusCode::TOO_MANY_REQUESTS {
        let retry_after = parse_retry_after(&response).unwrap_or(Duration::from_secs(60));
        return Err(RequestFailure::RateLimited(retry_after));
    }

    if !response.status().is_success() {
        warn!("음악 링크 매핑 응답 오류: {}", response.status());
        return Err(RequestFailure::Other);
    }

    let payload: OdesliResponse = match response.json().await {
        Ok(payload) => payload,
        Err(err) => {
            warn!("음악 링크 매핑 응답 파싱 실패: {:?}", err);
            return Err(RequestFailure::Other);
        }
    };

    let mut mapped = HashMap::new();
    for (platform_key, link) in payload.links_by_platform {
        if let Some(platform) = platform_from_key(&platform_key) {
            mapped.insert(platform, link.url);
        }
    }

    if mapped.is_empty() {
        Err(RequestFailure::Other)
    } else {
        Ok(mapped)
    }
}

fn parse_retry_after(response: &reqwest::Response) -> Option<Duration> {
    let value = response.headers().get(RETRY_AFTER)?;
    let raw = value.to_str().ok()?;
    if let Ok(seconds) = raw.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    let date = DateTime::parse_from_rfc2822(raw).ok()?;
    let now = Utc::now();
    date.with_timezone(&Utc)
        .signed_duration_since(now)
        .to_std()
        .ok()
}

fn parse_bool_env(key: &str) -> bool {
    std::env::var(key)
        .map(|raw| {
            matches!(
                raw.trim().to_lowercase().as_str(),
                "1" | "true" | "yes" | "y" | "on"
            )
        })
        .unwrap_or(false)
}
