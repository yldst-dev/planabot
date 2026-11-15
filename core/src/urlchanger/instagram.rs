use std::sync::LazyLock;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use regex::Regex;
use url::Url;

use super::http::{read_body_limited, unescape_html};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MEDIA_BYTES: usize = 45 * 1024 * 1024;
const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;
const MAX_REDIRECTS: usize = 10;
const USER_AGENT: &str = "TelegramBot (like TwitterBot)";

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("리디렉션이 너무 많습니다")
            } else if attempt.url().host_str().is_some_and(is_allowed_host) {
                attempt.follow()
            } else {
                attempt.error("허용되지 않은 리디렉션 호스트입니다")
            }
        }))
        .build()
        .unwrap_or_default()
});
static OG_IMAGE_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<meta\b[^>]*property\s*=\s*"og:image"[^>]*content\s*=\s*"([^"]+)""#).unwrap()
});
static OG_IMAGE_RE_REV: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)<meta\b[^>]*content\s*=\s*"([^"]+)"[^>]*property\s*=\s*"og:image""#).unwrap()
});
static OG_VIDEO_RE: LazyLock<Regex> = LazyLock::new(|| {
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
    pub size: Option<(u32, u32)>,
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
    let is_post = if let Some(code) = instagram_shortcode(original_url) {
        for candidate in video_candidates(&code) {
            if let Some(media) = download_if_kind(&candidate, InstagramMediaKind::Video).await {
                return Ok(media);
            }
        }
        true
    } else {
        false
    };

    let page = fetch_text(original_url).await;
    let video_url = page.as_deref().ok().filter(|_| is_post).and_then(og_video);
    if let Some(video_url) = video_url {
        let media = download_if_kind(&video_url, InstagramMediaKind::Video).await;
        if let Some(media) = media {
            return Ok(media);
        }
    }

    let html = page?;
    if let Some(image_url) = og_image(&html) {
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

fn og_image(html: &str) -> Option<String> {
    OG_IMAGE_RE
        .captures(html)
        .or_else(|| OG_IMAGE_RE_REV.captures(html))
        .map(|cap| unescape_html(&cap[1]))
}

fn og_video(html: &str) -> Option<String> {
    OG_VIDEO_RE.captures(html).map(|cap| unescape_html(&cap[1]))
}

async fn fetch_text(url: &str) -> Result<String> {
    let parsed = Url::parse(url).context("Instagram URL 파싱 실패")?;
    let host = parsed.host_str().unwrap_or_default();
    if !is_allowed_host(host) {
        bail!("허용되지 않은 호스트: {host}");
    }
    let response = CLIENT.get(parsed).send().await?.error_for_status()?;
    let bytes = read_body_limited(response, MAX_PAGE_BYTES).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

async fn download_media(url: &str) -> Result<InstagramMedia> {
    let parsed = Url::parse(url).context("미디어 URL 파싱 실패")?;
    let host = parsed.host_str().unwrap_or_default();
    if !is_allowed_media_host(host) {
        bail!("허용되지 않은 미디어 호스트: {host}");
    }
    let response = CLIENT.get(parsed).send().await?.error_for_status()?;
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_string();
    let bytes = read_body_limited(response, MAX_MEDIA_BYTES).await?;
    if bytes.is_empty() {
        bail!("미디어 응답이 비어 있습니다");
    }
    let kind = sniff_kind(&content_type, &bytes)
        .ok_or_else(|| anyhow!("미디어 형식을 확인하지 못했습니다"))?;
    let (file_name, size) = match kind {
        InstagramMediaKind::Video => ("instagram.mp4", mp4_video_size(&bytes)),
        InstagramMediaKind::Photo => ("instagram.jpg", None),
    };
    Ok(InstagramMedia {
        kind,
        bytes,
        file_name,
        size,
    })
}

fn mp4_boxes(data: &[u8]) -> Vec<(&[u8], &[u8])> {
    let mut boxes = Vec::new();
    let mut offset = 0;
    while offset + 8 <= data.len() {
        let size32 = u32::from_be_bytes([
            data[offset],
            data[offset + 1],
            data[offset + 2],
            data[offset + 3],
        ]) as usize;
        let kind = &data[offset + 4..offset + 8];
        let (header, size) = match size32 {
            0 => (8, data.len() - offset),
            1 if offset + 16 <= data.len() => {
                let mut large = [0u8; 8];
                large.copy_from_slice(&data[offset + 8..offset + 16]);
                (16, u64::from_be_bytes(large) as usize)
            }
            _ => (8, size32),
        };
        let Some(end) = offset.checked_add(size) else {
            break;
        };
        if size < header || end > data.len() {
            break;
        }
        boxes.push((kind, &data[offset + header..end]));
        offset = end;
    }
    boxes
}

fn mp4_video_size(data: &[u8]) -> Option<(u32, u32)> {
    let moov = mp4_boxes(data)
        .into_iter()
        .find(|(kind, _)| *kind == b"moov")?
        .1;
    mp4_boxes(moov)
        .into_iter()
        .filter(|(kind, _)| *kind == b"trak")
        .filter_map(|(_, trak)| {
            mp4_boxes(trak)
                .into_iter()
                .find(|(kind, _)| *kind == b"tkhd")
        })
        .find_map(|(_, tkhd)| tkhd_display_size(tkhd))
}

fn tkhd_display_size(tkhd: &[u8]) -> Option<(u32, u32)> {
    let read = |at: usize| -> Option<u32> {
        Some(u32::from_be_bytes(tkhd.get(at..at + 4)?.try_into().ok()?))
    };
    let matrix = 4 + if *tkhd.first()? == 1 { 32 } else { 20 } + 16;
    let width = read(matrix + 36)? >> 16;
    let height = read(matrix + 40)? >> 16;
    if width == 0 || height == 0 {
        return None;
    }
    let rotated = read(matrix)? == 0 && read(matrix + 16)? == 0;
    Some(if rotated {
        (height, width)
    } else {
        (width, height)
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

fn is_allowed_host(host: &str) -> bool {
    matches!(host, "instagram.com" | "www.instagram.com") || is_allowed_media_host(host)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_instagram_and_its_media_hosts_may_be_fetched_or_redirected_to() {
        assert!(is_allowed_host("www.instagram.com"));
        assert!(is_allowed_host("scontent-ssn1-1.cdninstagram.com"));
        assert!(is_allowed_host("scontent.xx.fbcdn.net"));
        assert!(!is_allowed_host("192.168.0.6"));
        assert!(!is_allowed_host("instagram.com.evil.example"));
        assert!(!is_allowed_media_host("www.instagram.com"));
    }

    #[test]
    fn og_tags_are_read_in_either_attribute_order_and_unescaped() {
        let html = r#"<meta content="https://a/b?x=1&amp;y=2" property="og:image"><meta property="og:video" content="https://v/c.mp4">"#;
        assert_eq!(og_image(html).as_deref(), Some("https://a/b?x=1&y=2"));
        assert_eq!(og_video(html).as_deref(), Some("https://v/c.mp4"));
        assert_eq!(og_image("<html></html>"), None);
    }

    #[test]
    fn oversized_mp4_boxes_are_ignored_instead_of_panicking() {
        let mut bytes = vec![0, 0, 0, 8];
        bytes.extend_from_slice(b"ftyp");
        bytes.extend_from_slice(&[0, 0, 0, 1]);
        bytes.extend_from_slice(b"moov");
        bytes.extend_from_slice(&[0xFF; 8]);
        assert_eq!(mp4_video_size(&bytes), None);
    }

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

    fn mp4_box(kind: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = ((payload.len() + 8) as u32).to_be_bytes().to_vec();
        out.extend_from_slice(kind);
        out.extend_from_slice(payload);
        out
    }

    fn tkhd(version: u8, width: u32, height: u32, rotated: bool) -> Vec<u8> {
        let mut payload = vec![version, 0, 0, 0];
        payload.extend(vec![0u8; if version == 1 { 32 } else { 20 } + 16]);
        let (a, b, c, d) = if rotated {
            (0, 0x0001_0000u32, 0xFFFF_0000u32, 0)
        } else {
            (0x0001_0000u32, 0, 0, 0x0001_0000u32)
        };
        for value in [a, b, 0, c, d, 0, 0, 0, 0x4000_0000] {
            payload.extend_from_slice(&value.to_be_bytes());
        }
        payload.extend_from_slice(&(width << 16).to_be_bytes());
        payload.extend_from_slice(&(height << 16).to_be_bytes());
        mp4_box(b"tkhd", &payload)
    }

    fn movie(tracks: &[Vec<u8>]) -> Vec<u8> {
        let traks: Vec<u8> = tracks.iter().flat_map(|t| mp4_box(b"trak", t)).collect();
        let mut out = mp4_box(b"ftyp", b"isom\0\0\0\0");
        out.extend(mp4_box(b"moov", &traks));
        out.extend(mp4_box(b"mdat", &[0u8; 16]));
        out
    }

    #[test]
    fn test_mp4_video_size_reads_the_video_track() {
        let audio = tkhd(0, 0, 0, false);
        assert_eq!(
            mp4_video_size(&movie(&[audio.clone(), tkhd(0, 720, 1280, false)])),
            Some((720, 1280))
        );
        assert_eq!(
            mp4_video_size(&movie(&[tkhd(1, 1920, 1080, false)])),
            Some((1920, 1080))
        );
        assert_eq!(
            mp4_video_size(&movie(&[tkhd(0, 1280, 720, true)])),
            Some((720, 1280))
        );
    }

    #[test]
    fn test_mp4_video_size_rejects_broken_files() {
        assert_eq!(mp4_video_size(&movie(&[tkhd(0, 0, 0, false)])), None);
        assert_eq!(mp4_video_size(b"not an mp4 at all"), None);
        assert_eq!(mp4_video_size(&[]), None);
        let mut truncated = movie(&[tkhd(0, 720, 1280, false)]);
        truncated.truncate(60);
        assert_eq!(mp4_video_size(&truncated), None);
    }

    #[tokio::test]
    #[ignore]
    async fn fetch_public_reel_preview() {
        let media = fetch_instagram_media("https://www.instagram.com/reel/Dcx3ct3CWX_/")
            .await
            .expect("preview");
        assert_eq!(media.kind, InstagramMediaKind::Video);
        assert!(media.bytes.len() > 1024);
        assert_eq!(media.size, Some((720, 1280)));
    }
}
