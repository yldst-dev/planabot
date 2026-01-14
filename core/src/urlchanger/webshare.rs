use log::warn;
use serde::Deserialize;
use url::Url;

const WEBSHARE_PROXY_LIST_ENDPOINT: &str = "https://proxy.webshare.io/api/v2/proxy/list/";

#[derive(Debug, Clone)]
pub struct WebshareConfig {
    pub api_key: String,
    pub mode: String,
    pub country_codes: Option<String>,
    pub plan_id: Option<String>,
    pub page_size: u32,
}

impl WebshareConfig {
    pub fn from_env() -> Option<Self> {
        let api_key = std::env::var("WEBSHARE_API_KEY").ok()?;
        let api_key = api_key.trim().to_string();
        if api_key.is_empty() {
            return None;
        }

        let mode = std::env::var("WEBSHARE_MODE")
            .unwrap_or_else(|_| "direct".to_string())
            .trim()
            .to_lowercase();
        let country_codes = std::env::var("WEBSHARE_COUNTRY_CODES")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty());
        let plan_id = std::env::var("WEBSHARE_PLAN_ID")
            .ok()
            .map(|raw| raw.trim().to_string())
            .filter(|raw| !raw.is_empty());
        let page_size = std::env::var("WEBSHARE_PAGE_SIZE")
            .ok()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .unwrap_or(25);

        Some(Self {
            api_key,
            mode,
            country_codes,
            plan_id,
            page_size,
        })
    }
}

#[derive(Debug, Clone)]
pub struct WebshareProxy {
    pub username: String,
    pub password: String,
    pub host: String,
    pub port: u16,
}

impl WebshareProxy {
    pub fn to_url(&self) -> String {
        format!(
            "http://{}:{}@{}:{}",
            self.username, self.password, self.host, self.port
        )
    }
}

#[derive(Debug, Deserialize)]
struct WebshareListResponse {
    results: Vec<WebshareProxyEntry>,
}

#[derive(Debug, Deserialize)]
struct WebshareProxyEntry {
    username: String,
    password: String,
    #[serde(rename = "proxy_address")]
    proxy_address: Option<String>,
    port: u16,
    valid: bool,
}

pub async fn fetch_webshare_proxies(
    client: &reqwest::Client,
    config: &WebshareConfig,
) -> Vec<WebshareProxy> {
    let mut url = match Url::parse(WEBSHARE_PROXY_LIST_ENDPOINT) {
        Ok(url) => url,
        Err(err) => {
            warn!("Webshare URL 파싱 실패: {:?}", err);
            return Vec::new();
        }
    };

    {
        let mut query = url.query_pairs_mut();
        query.append_pair("mode", config.mode.as_str());
        query.append_pair("page", "1");
        query.append_pair("page_size", &config.page_size.to_string());
        if let Some(country_codes) = &config.country_codes {
            query.append_pair("country_code__in", country_codes.as_str());
        }
        if let Some(plan_id) = &config.plan_id {
            query.append_pair("plan_id", plan_id.as_str());
        }
    }

    let response = match client
        .get(url)
        .header("Authorization", format!("Token {}", config.api_key))
        .send()
        .await
    {
        Ok(response) => response,
        Err(err) => {
            warn!("Webshare 프록시 목록 요청 실패: {:?}", err);
            return Vec::new();
        }
    };

    if !response.status().is_success() {
        warn!("Webshare 프록시 목록 응답 오류: {}", response.status());
        return Vec::new();
    }

    let payload: WebshareListResponse = match response.json().await {
        Ok(payload) => payload,
        Err(err) => {
            warn!("Webshare 프록시 목록 파싱 실패: {:?}", err);
            return Vec::new();
        }
    };

    let mut proxies = Vec::new();
    for entry in payload.results {
        if !entry.valid {
            continue;
        }
        let host = if config.mode == "backbone" {
            "p.webshare.io".to_string()
        } else if let Some(address) = entry.proxy_address {
            address
        } else {
            warn!("Webshare 프록시 주소가 비어 있어 건너뜁니다.");
            continue;
        };
        proxies.push(WebshareProxy {
            username: entry.username,
            password: entry.password,
            host,
            port: entry.port,
        });
    }

    proxies
}
