use std::time::Duration;

use anyhow::{Context, Result};
use log::{error, warn};
use once_cell::sync::Lazy;
use regex::Regex;
use reqwest::{Client, StatusCode};
use serde::Deserialize;

#[derive(Clone)]
pub struct GalleryClient {
    client: Client,
}

impl GalleryClient {
    pub fn new() -> Self {
        let client = Client::builder()
            .timeout(Duration::from_secs(15))
            .user_agent("eyetracker-rs/0.1")
            .build()
            .expect("reqwest client should build");

        Self { client }
    }

    pub async fn get_gallery_info(&self, gallery_id: &str) -> Result<Option<GalleryInfo>> {
        let url = format!(
            "https://ltn.gold-usergeneratedcontent.net/galleries/{}.js",
            gallery_id
        );
        let referer = format!("https://hitomi.la/reader/{}.html", gallery_id);

        let response = match self
            .client
            .get(&url)
            .header("Referer", referer)
            .send()
            .await
        {
            Ok(resp) => resp,
            Err(err) => {
                warn!("갤러리 JS 요청 실패 (ID {}): {}", gallery_id, err);
                return Ok(None);
            }
        };

        if response.status() == StatusCode::NOT_FOUND {
            return Ok(None);
        }

        if !response.status().is_success() {
            warn!(
                "갤러리 JS 응답 오류 (ID {}): {} {}",
                gallery_id,
                response.status(),
                response.text().await.unwrap_or_default()
            );
            return Ok(None);
        }

        let raw_text = response
            .text()
            .await
            .context("갤러리 JS 응답을 텍스트로 읽는데 실패")?;

        let normalized = normalize_js_payload(raw_text);

        let raw: GalleryRaw = match serde_json::from_str(&normalized) {
            Ok(data) => data,
            Err(err) => {
                error!("갤러리 JSON 파싱 실패 (ID {}): {}", gallery_id, err);
                return Ok(None);
            }
        };

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
    tags: Vec<Tag>,
    #[serde(default)]
    t: Vec<Tag>,
    #[serde(default)]
    artists: Vec<Artist>,
    #[serde(default)]
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
    for tag in a.into_iter().chain(b.into_iter()) {
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
    for artist in a.into_iter().chain(b.into_iter()) {
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

fn normalize_js_payload(raw: String) -> String {
    static PREFIX: Lazy<Regex> = Lazy::new(|| Regex::new(r"^\s*var\s+galleryinfo\s*=\s*").unwrap());

    let without_prefix = PREFIX.replace(raw.trim_start(), "");
    let trimmed = without_prefix.trim();
    trimmed.trim_end_matches(';').to_string()
}
