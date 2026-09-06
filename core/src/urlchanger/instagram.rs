use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use once_cell::sync::Lazy;
use regex::Regex;
use url::Url;

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MEDIA_BYTES: usize = 45 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;
const USER_AGENT: &str = "TelegramBot (like TwitterBot)";

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_default()
});
static OG_IMAGE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<meta\b[^>]*property\s*=\s*"og:image"[^>]*content\s*=\s*"([^"]+)""#).unwrap()
});
static OG_IMAGE_RE_REV: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<meta\b[^>]*content\s*=\s*"([^"]+)"[^>]*property\s*=\s*"og:image""#).unwrap()
});
static OG_VIDEO_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r#"(?is)<meta\b[^>]*property\s*=\s*"og:video(?:\:url|\:secure_url)?"[^>]*content\s*=\s*"([^"]+)""#).unwrap()
});

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstagramMediaKind {
    Video,
    Photo,
}

#[derive(Debug, Clone)]
pub struct InstagramMedia {
    pub kind: InstagramMediaKind,
    pub bytes: Vec<u8>,
    pub file_name: &'static str,
}

pub fn instagram_shortcode(url: &str) -> Option<String> {
    let parsed = Url::parse(url).ok()?;
    let segs: Vec<&str> = parsed
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    let first = segs.first().copied()?;
    if matches!(first, "share" | "stories" | "explore") {
        return None;
    }
    let marker = segs
        .iter()
        .position(|segment| matches!(*segment, "p" | "reel" | "reels" | "tv"))?;
    let code = segs.get(marker + 1)?;
    if code
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        Some((*code).to_string())
    } else {
        None
    }
}

pub async fn fetch_instagram_media(original_url: &str) -> Result<InstagramMedia> {
    if let Some(code) = instagram_shortcode(original_url) {
        for candidate in video_candidates(&code) {
            if let Some(media) = download_if_kind(&candidate, InstagramMediaKind::Video).await {
                return Ok(media);
            }
        }
        if let Ok(Some(video_url)) = crawler_og_video(original_url).await
            && let Some(media) = download_if_kind(&video_url, InstagramMediaKind::Video).await
        {
            return Ok(media);
        }
    }

    if let Some(image_url) = crawler_og_image(original_url).await? {
        let media = download_media(&image_url).await?;
        if media.kind == InstagramMediaKind::Photo {
            return Ok(media);
        }
        bail!("이미지 응답이 아닙니다");
    }

    bail!("미리보기 미디어를 찾지 못했습니다")
}

async fn download_if_kind(url: &str, kind: InstagramMediaKind) -> Option<InstagramMedia> {
    match download_media(url).await {
        Ok(media) if media.kind == kind => Some(media),
        _ => None,
    }
}

fn video_candidates(code: &str) -> Vec<String> {
    vec![
        format!("https://kirkstagram.com/videos/{code}/1"),
        format!("https://instagramfix.com/videos/{code}/1"),
        format!("https://vxinstagram.com/offload/{code}/0.mp4"),
    ]
}

async fn crawler_og_image(original_url: &str) -> Result<Option<String>> {
    let html = fetch_text(original_url).await?;
    if let Some(cap) = OG_IMAGE_RE.captures(&html) {
        return Ok(Some(unescape_html(&cap[1])));
    }
    if let Some(cap) = OG_IMAGE_RE_REV.captures(&html) {
        return Ok(Some(unescape_html(&cap[1])));
    }
    Ok(None)
}

async fn crawler_og_video(original_url: &str) -> Result<Option<String>> {
    let html = fetch_text(original_url).await?;
    if let Some(cap) = OG_VIDEO_RE.captures(&html) {
        return Ok(Some(unescape_html(&cap[1])));
    }
    Ok(None)
}

async fn fetch_text(url: &str) -> Result<String> {
    let parsed = Url::parse(url).context("Instagram URL 파싱 실패")?;
    let response = CLIENT.get(parsed).send().await?.error_for_status()?;
    let bytes = read_body_limited(response, MAX_PAGE_BYTES).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn download_media(url: &str) -> Result<InstagramMedia> {
    let parsed = Url::parse(url).context("미디어 URL 파싱 실패")?;
    let response = CLIENT.get(parsed).send().await?.error_for_status()?;
    let final_url = response.url().clone();
    let host = final_url.host_str().unwrap_or_default();
    if !is_allowed_media_host(host) {
        bail!("허용되지 않은 미디어 호스트: {host}");
    }
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = read_body_limited(response, MAX_MEDIA_BYTES).await?;
    let kind = sniff_kind(&content_type, &bytes)
        .ok_or_else(|| anyhow!("미디어 형식을 확인하지 못했습니다"))?;
    let file_name = match kind {
        InstagramMediaKind::Video => "instagram.mp4",
        InstagramMediaKind::Photo => "instagram.jpg",
    };
    Ok(InstagramMedia {
        kind,
        bytes,
        file_name,
    })
}

fn sniff_kind(content_type: &str, bytes: &[u8]) -> Option<InstagramMediaKind> {
    if bytes.len() >= 12 && &bytes[4..8] == b"ftyp" {
        return Some(InstagramMediaKind::Video);
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some(InstagramMediaKind::Photo);
    }
    if bytes.starts_with(b"<!DOCTYPE") || bytes.starts_with(b"<html") || bytes.starts_with(b"{") {
        return None;
    }
    let lowered = content_type.to_ascii_lowercase();
    if lowered.contains("video") {
        return Some(InstagramMediaKind::Video);
    }
    if lowered.contains("image") {
        return Some(InstagramMediaKind::Photo);
    }
    None
}

fn is_allowed_media_host(host: &str) -> bool {
    matches!(
        host,
        "kirkstagram.com"
            | "www.kirkstagram.com"
            | "instagramfix.com"
            | "www.instagramfix.com"
            | "vxinstagram.com"
            | "www.vxinstagram.com"
            | "scontent.cdninstagram.com"
    ) || host.ends_with(".cdninstagram.com")
        || host.ends_with(".fbcdn.net")
}

fn unescape_html(value: &str) -> String {
    value
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
}

async fn read_body_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>> {
    let declared = response.content_length().unwrap_or(0);
    if declared as usize > limit {
        bail!("응답 크기 초과: {} bytes", declared);
    }
    let mut buf = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if buf.len() + chunk.len() > limit {
            bail!("응답 크기 초과: {} bytes 이상", limit);
        }
        buf.extend_from_slice(&chunk);
    }
    if buf.is_empty() {
        bail!("미디어 응답이 비어 있습니다");
    }
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_shortcode_from_reel() {
        assert_eq!(
            instagram_shortcode("https://www.instagram.com/reel/Dcx3ct3CWX_/"),
            Some("Dcx3ct3CWX_".to_string())
        );
    }

    #[test]
    fn test_shortcode_from_post_with_query() {
        assert_eq!(
            instagram_shortcode(
                "https://www.instagram.com/p/DR_uVJVklbf/?utm_source=ig_web_copy_link"
            ),
            Some("DR_uVJVklbf".to_string())
        );
    }

    #[test]
    fn test_shortcode_from_username_path() {
        assert_eq!(
            instagram_shortcode("https://www.instagram.com/final_audio/reel/Dcx3ct3CWX_/"),
            Some("Dcx3ct3CWX_".to_string())
        );
    }

    #[test]
    fn test_shortcode_skips_stories_and_share() {
        assert_eq!(
            instagram_shortcode("https://www.instagram.com/stories/final_audio/123"),
            None
        );
        assert_eq!(
            instagram_shortcode("https://www.instagram.com/share/ABC"),
            None
        );
    }

    #[test]
    fn test_sniff_mp4_and_jpeg() {
        let mut mp4 = vec![0, 0, 0, 0x20];
        mp4.extend_from_slice(b"ftypisom");
        assert_eq!(
            sniff_kind("application/octet-stream", &mp4),
            Some(InstagramMediaKind::Video)
        );
        assert_eq!(
            sniff_kind("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0]),
            Some(InstagramMediaKind::Photo)
        );
        assert_eq!(sniff_kind("text/html", b"<!DOCTYPE html>"), None);
    }

    #[tokio::test]
    #[ignore]
    async fn fetch_public_reel_preview() {
        let media = fetch_instagram_media("https://www.instagram.com/reel/Dcx3ct3CWX_/")
            .await
            .expect("preview");
        assert_eq!(media.kind, InstagramMediaKind::Video);
        assert!(media.bytes.len() > 1024);
    }
}
