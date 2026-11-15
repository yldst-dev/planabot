use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use reqwest::{Client, StatusCode};
use serde::{Deserialize, Deserializer};

const GALLERY_BASE_URL: &str = "https://ltn.gold-usergeneratedcontent.net";

#[derive(Clone)]
pub struct GalleryClient {
    client: Client,
    base_url: String,
}

impl GalleryClient {
    pub fn new() -> Self {
        Self::with_base_url(GALLERY_BASE_URL)
    }

    pub(crate) fn with_base_url(base_url: &str) -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("eyetracker-rs/0.1")
            .build()
            .expect("reqwest client should build");

        Self {
            client,
            base_url: base_url.to_string(),
        }
    }

    pub async fn get_gallery_info(&self, gallery_id: &str) -> Result<Option<GalleryInfo>> {
        let url = format!("{}/galleries/{}.js", self.base_url, gallery_id);
        let referer = format!("https://hitomi.la/reader/{}.html", gallery_id);

        let response = self
            .client
            .get(&url)
            .header("Referer", referer)
            .send()
            .await
            .map_err(|err| anyhow!("갤러리 JS 요청 실패 (ID {gallery_id}): {err}"))?;

        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }

        if !response.status().is_success() {
            bail!(
                "갤러리 JS 응답 오류 (ID {gallery_id}): {}",
                response.status()
            );
        }

        let raw_text = response
            .text()
            .await
            .context("갤러리 JS 응답을 텍스트로 읽는데 실패")?;

        let normalized = normalize_js_payload(raw_text);

        let raw: GalleryRaw = serde_json::from_str(&normalized)
            .map_err(|err| anyhow!("갤러리 JSON 파싱 실패 (ID {gallery_id}): {err}"))?;

        Ok(Some(GalleryInfo::from_raw(gallery_id.to_string(), raw)))
    }
}

#[derive(Debug, Clone)]
pub struct GalleryInfo {
    pub id: String,
    pub title: String,
    pub artists: String,
    pub language: String,
    pub tags: Vec<String>,
}

impl GalleryInfo {
    pub fn hitomi_url(&self) -> String {
        format!("https://hitomi.la/galleries/{}.html", self.id)
    }

    pub fn k_hentai_url(&self) -> String {
        format!("https://k-hentai.org/r/{}", self.id)
    }

    fn from_raw(id: String, raw: GalleryRaw) -> Self {
        let title = raw
            .title
            .or(raw.n)
            .unwrap_or_else(|| "정보 없음".to_string());

        let tags = merge_tags(raw.tags, raw.t);
        let artists_vec = merge_artists(raw.artists, raw.a);
        let artists = if artists_vec.is_empty() {
            "정보 없음".to_string()
        } else {
            artists_vec.join(", ")
        };

        let language = raw
            .language_localname
            .or(raw.language)
            .unwrap_or_else(|| "정보 없음".to_string());

        Self {
            id,
            title,
            artists,
            language,
            tags,
        }
    }
}

#[derive(Debug, Deserialize)]
struct GalleryRaw {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    n: Option<String>,
    #[serde(default)]
    #[serde(deserialize_with = "null_to_empty_vec")]
    tags: Vec<Tag>,
    #[serde(default)]
    #[serde(deserialize_with = "null_to_empty_vec")]
    t: Vec<Tag>,
    #[serde(default)]
    #[serde(deserialize_with = "null_to_empty_vec")]
    artists: Vec<Artist>,
    #[serde(default)]
    #[serde(deserialize_with = "null_to_empty_vec")]
    a: Vec<Artist>,
    #[serde(default)]
    language_localname: Option<String>,
    #[serde(default)]
    language: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Tag {
    Simple(String),
    Object { tag: Option<String> },
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Artist {
    Simple(String),
    Object { artist: Option<String> },
}

fn merge_tags(a: Vec<Tag>, b: Vec<Tag>) -> Vec<String> {
    let mut out = Vec::new();
    for tag in a.into_iter().chain(b) {
        let value = match tag {
            Tag::Simple(s) => Some(s),
            Tag::Object { tag } => tag,
        };

        if let Some(v) = value {
            let trimmed = v.trim();
            if !trimmed.is_empty() && !out.contains(&trimmed.to_string()) {
                out.push(trimmed.to_string());
            }
        }
    }
    out
}

fn merge_artists(a: Vec<Artist>, b: Vec<Artist>) -> Vec<String> {
    let mut out = Vec::new();
    for artist in a.into_iter().chain(b) {
        let value = match artist {
            Artist::Simple(s) => Some(s),
            Artist::Object { artist } => artist,
        };

        if let Some(v) = value {
            let trimmed = v.trim();
            if !trimmed.is_empty() && !out.contains(&trimmed.to_string()) {
                out.push(trimmed.to_string());
            }
        }
    }
    out
}

fn null_to_empty_vec<'de, D, T>(deserializer: D) -> std::result::Result<Vec<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Option::<Vec<T>>::deserialize(deserializer)?.unwrap_or_default())
}

fn normalize_js_payload(raw: String) -> String {
    static PREFIX: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\s*var\s+galleryinfo\s*=\s*").unwrap());

    let without_prefix = PREFIX.replace(raw.trim_start(), "");
    let trimmed = without_prefix.trim();
    trimmed.trim_end_matches(';').to_string()
}

#[cfg(test)]
mod tests {
    use super::{GalleryClient, GalleryInfo, GalleryRaw, normalize_js_payload};

    async fn client_for(status: u16, body: &'static str) -> GalleryClient {
        let app = axum::Router::new().fallback(move || async move {
            (axum::http::StatusCode::from_u16(status).unwrap(), body)
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, app).await });
        GalleryClient::with_base_url(&url)
    }

    #[tokio::test]
    async fn a_gallery_that_does_not_exist_is_none() {
        let client = client_for(404, "not found").await;
        assert!(client.get_gallery_info("1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_served_gallery_is_parsed() {
        let client = client_for(200, r#"var galleryinfo = {"title":"Sample"};"#).await;
        let info = client.get_gallery_info("1").await.unwrap().unwrap();
        assert_eq!(info.title, "Sample");
    }

    #[tokio::test]
    async fn http_failures_are_errors_not_missing_galleries() {
        for status in [403, 429, 500, 503] {
            let client = client_for(status, "blocked").await;
            let err = client.get_gallery_info("1").await.unwrap_err();
            assert!(err.to_string().contains(&status.to_string()), "{err}");
        }
    }

    #[tokio::test]
    async fn a_body_that_is_not_gallery_json_is_an_error() {
        let client = client_for(200, "<html>blocked</html>").await;
        assert!(client.get_gallery_info("1").await.is_err());
    }

    #[tokio::test]
    async fn an_unreachable_server_is_an_error() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let client = GalleryClient::with_base_url(&url);
        assert!(client.get_gallery_info("1").await.is_err());
    }

    #[test]
    fn parses_gallery_with_null_artists() {
        let raw = r#"var galleryinfo = {"title":"Sample","tags":[{"tag":"korean"}],"artists":null,"a":null,"language_localname":"한국어"};"#;
        let normalized = normalize_js_payload(raw.to_string());
        let parsed: GalleryRaw = serde_json::from_str(&normalized).unwrap();
        let info = GalleryInfo::from_raw("2732349".to_string(), parsed);

        assert_eq!(info.id, "2732349");
        assert_eq!(info.title, "Sample");
        assert_eq!(info.artists, "정보 없음");
        assert_eq!(info.language, "한국어");
        assert_eq!(info.tags, vec!["korean"]);
    }

    #[test]
    fn parses_gallery_with_null_tags_and_artist_aliases() {
        let raw = r#"{"n":"Fallback","tags":null,"t":null,"artists":null,"a":[{"artist":"alpha"}],"language":"korean"}"#;
        let parsed: GalleryRaw = serde_json::from_str(raw).unwrap();
        let info = GalleryInfo::from_raw("100".to_string(), parsed);

        assert_eq!(info.title, "Fallback");
        assert_eq!(info.artists, "alpha");
        assert_eq!(info.language, "korean");
        assert!(info.tags.is_empty());
    }
}
