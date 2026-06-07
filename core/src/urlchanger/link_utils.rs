use log::warn;
use once_cell::sync::Lazy;
use regex::Regex;
use url::Url;

static MUSIC_YOUTUBE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"https?://(?:www\.|m\.)?youtu(?:\.be|be\.com)/\S+").unwrap());
static MUSIC_YOUTUBE_MUSIC_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"https?://(?:www\.)?music\.youtube\.com/\S+").unwrap());
static MUSIC_SPOTIFY_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"https?://(?:www\.)?open\.spotify\.com/\S+").unwrap());
static MUSIC_APPLE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"https?://(?:www\.)?music\.apple\.com/\S+").unwrap());
static MUSIC_YOUTUBE_CAPTURE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(https?://(?:www\.|m\.)?youtu(?:\.be|be\.com)/\S+)").unwrap());
static MUSIC_YOUTUBE_MUSIC_CAPTURE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(https?://(?:www\.)?music\.youtube\.com/\S+)").unwrap());
static MUSIC_SPOTIFY_CAPTURE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(https?://(?:www\.)?open\.spotify\.com/\S+)").unwrap());
static MUSIC_APPLE_CAPTURE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(https?://(?:www\.)?music\.apple\.com/\S+)").unwrap());
static X_LINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\.?https?://(?:www\.)?(?:x|twitter)\.com/\S+").unwrap());
static X_LINK_CAPTURE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\.?)(https?://(?:www\.)?(?:x|twitter)\.com/\S+)").unwrap());
static INSTAGRAM_LINK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"https?://(?:www\.)?instagram\.com/\S+").unwrap());
static INSTAGRAM_CAPTURE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(https?://(?:www\.)?instagram\.com/\S+)").unwrap());
static THREADS_LINK_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"https?://(?:www\.)?threads\.(?:com|net)/(?:@[\w.]+/post|t)/\S+").unwrap()
});
static THREADS_CAPTURE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(https?://(?:www\.)?threads\.(?:com|net)/(?:@[\w.]+/post|t)/\S+)").unwrap()
});

const INSTAGRAM_PRIMARY_HOST: &str = "vxinstagram.com";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinkConversion {
    pub original: String,
    pub converted: String,
    pub cleaned_original: String,
    pub disable_preview: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MusicPlatform {
    Spotify,
    YouTubeMusic,
    YouTube,
    AppleMusic,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MusicLink {
    pub original: String,
    pub cleaned: String,
    pub platform: MusicPlatform,
    pub had_tracking: bool,
}

pub fn contains_music_link(text: &str) -> bool {
    MUSIC_YOUTUBE_RE.is_match(text)
        || MUSIC_YOUTUBE_MUSIC_RE.is_match(text)
        || MUSIC_SPOTIFY_RE.is_match(text)
        || MUSIC_APPLE_RE.is_match(text)
}

pub fn contains_x_link(text: &str) -> bool {
    X_LINK_RE.is_match(text)
}

pub fn contains_instagram_link(text: &str) -> bool {
    INSTAGRAM_LINK_RE.is_match(text)
}

pub fn contains_threads_link(text: &str) -> bool {
    THREADS_LINK_RE.is_match(text)
}

pub fn clean_music_url(url_str: &str) -> String {
    if let Ok(mut url) = Url::parse(url_str) {
        if url.query().is_some() {
            let query_pairs: Vec<(String, String)> = url
                .query_pairs()
                .filter(|(k, _)| !is_tracking_param(k))
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();

            if query_pairs.is_empty() {
                url.set_query(None);
            } else {
                let mut pairs = url.query_pairs_mut();
                pairs.clear();
                for (key, value) in query_pairs {
                    pairs.append_pair(&key, &value);
                }
            }
        }

        if url.host_str() == Some("youtu.be") {
            let path = url.path().to_string();
            if path.contains("si=") {
                let new_path = path.split("si=").next().unwrap_or("").trim_end_matches('?');
                url.set_path(new_path);
            }
        }

        return url.to_string();
    }

    url_str.to_string()
}

pub fn extract_music_links(text: &str) -> Vec<MusicLink> {
    let mut links = Vec::new();

    for cap in MUSIC_YOUTUBE_CAPTURE_RE.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let original_url = m.as_str();
            if let Some(link) = build_music_link(original_url) {
                links.push(link);
            }
        }
    }

    for cap in MUSIC_YOUTUBE_MUSIC_CAPTURE_RE.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let original_url = m.as_str();
            if let Some(link) = build_music_link(original_url) {
                links.push(link);
            }
        }
    }

    for cap in MUSIC_SPOTIFY_CAPTURE_RE.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let original_url = m.as_str();
            if let Some(link) = build_music_link(original_url) {
                links.push(link);
            }
        }
    }

    for cap in MUSIC_APPLE_CAPTURE_RE.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let original_url = m.as_str();
            if let Some(link) = build_music_link(original_url) {
                links.push(link);
            }
        }
    }

    links
}

fn build_music_link(original_url: &str) -> Option<MusicLink> {
    let parsed = Url::parse(original_url).ok()?;
    let platform = detect_music_platform(&parsed)?;
    let cleaned = clean_music_url(original_url);
    let had_tracking = has_tracking_params(&parsed, original_url);
    Some(MusicLink {
        original: original_url.to_string(),
        cleaned,
        platform,
        had_tracking,
    })
}

fn detect_music_platform(url: &Url) -> Option<MusicPlatform> {
    match url.host_str()? {
        "open.spotify.com" => Some(MusicPlatform::Spotify),
        "music.youtube.com" => Some(MusicPlatform::YouTubeMusic),
        "youtube.com" | "www.youtube.com" | "m.youtube.com" | "youtu.be" => {
            Some(MusicPlatform::YouTube)
        }
        "music.apple.com" => Some(MusicPlatform::AppleMusic),
        _ => None,
    }
}

fn is_tracking_param(key: &str) -> bool {
    matches!(
        key,
        "si" | "fbclid"
            | "igshid"
            | "gclid"
            | "wbraid"
            | "gbraid"
            | "msclkid"
            | "at"
            | "ct"
            | "itscg"
            | "itsct"
            | "ls"
            | "uo"
            | "xmt"
    ) || key.starts_with("utm_")
}

fn has_tracking_params(url: &Url, raw: &str) -> bool {
    if url
        .query_pairs()
        .any(|(key, _)| is_tracking_param(key.as_ref()))
    {
        return true;
    }
    if url.host_str() == Some("youtu.be") && raw.contains("si=") {
        return true;
    }
    false
}

pub fn convert_x_links(text: &str) -> Vec<LinkConversion> {
    let mut links = Vec::new();

    for cap in X_LINK_CAPTURE_RE.captures_iter(text) {
        let dot_prefix = cap.get(1).map(|m| m.as_str() == ".").unwrap_or(false);
        if let Some(url_match) = cap.get(2) {
            let original_url = url_match.as_str();
            match Url::parse(original_url) {
                Ok(mut parsed) => {
                    let cleaned_original = {
                        parsed.set_query(None);
                        parsed.set_fragment(None);
                        parsed.to_string()
                    };
                    parsed.set_host(Some("fxtwitter.com")).ok();
                    let original_in_text = if dot_prefix {
                        format!(".{}", original_url)
                    } else {
                        original_url.to_string()
                    };
                    links.push(LinkConversion {
                        original: original_in_text,
                        converted: parsed.to_string(),
                        cleaned_original,
                        disable_preview: dot_prefix,
                    });
                }
                Err(e) => warn!("X 링크 파싱 실패: {}", e),
            }
        }
    }

    links
}

fn build_social_conversion(
    original_url: &str,
    primary_host: &str,
) -> Result<LinkConversion, url::ParseError> {
    let mut parsed = Url::parse(original_url)?;
    parsed.set_query(None);
    parsed.set_fragment(None);
    let cleaned_original = parsed.to_string();

    parsed.set_host(Some(primary_host)).ok();
    Ok(LinkConversion {
        original: original_url.to_string(),
        converted: parsed.to_string(),
        cleaned_original,
        disable_preview: false,
    })
}

fn build_threads_tracking_cleanup(
    original_url: &str,
) -> Result<Option<LinkConversion>, url::ParseError> {
    let mut parsed = Url::parse(original_url)?;
    let had_fragment = parsed.fragment().is_some();
    let had_tracking_query = parsed
        .query_pairs()
        .any(|(key, _)| is_tracking_param(key.as_ref()));

    if !had_fragment && !had_tracking_query {
        return Ok(None);
    }

    if parsed.query().is_some() {
        let query_pairs: Vec<(String, String)> = parsed
            .query_pairs()
            .filter(|(key, _)| !is_tracking_param(key.as_ref()))
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();

        if query_pairs.is_empty() {
            parsed.set_query(None);
        } else {
            let mut pairs = parsed.query_pairs_mut();
            pairs.clear();
            for (key, value) in query_pairs {
                pairs.append_pair(&key, &value);
            }
        }
    }
    parsed.set_fragment(None);
    let cleaned = parsed.to_string();

    Ok(Some(LinkConversion {
        original: original_url.to_string(),
        converted: cleaned.clone(),
        cleaned_original: cleaned,
        disable_preview: false,
    }))
}

pub fn convert_instagram_links(text: &str) -> Vec<LinkConversion> {
    let mut links = Vec::new();

    for cap in INSTAGRAM_CAPTURE_RE.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let original_url = m.as_str();
            match build_social_conversion(original_url, INSTAGRAM_PRIMARY_HOST) {
                Ok(link) => links.push(link),
                Err(e) => warn!("Instagram 링크 파싱 실패: {}", e),
            }
        }
    }

    links
}

pub fn convert_threads_links(text: &str) -> Vec<LinkConversion> {
    let mut links = Vec::new();

    for cap in THREADS_CAPTURE_RE.captures_iter(text) {
        if let Some(m) = cap.get(1) {
            let original_url = m.as_str();
            match build_threads_tracking_cleanup(original_url) {
                Ok(Some(link)) => links.push(link),
                Ok(None) => {}
                Err(e) => warn!("Threads 링크 파싱 실패: {}", e),
            }
        }
    }

    links
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_remove_si_parameter_youtube() {
        let original = "https://youtu.be/Vc-ByDGOuQE?si=qIy-ihfrRKmDAPZP";
        let expected = "https://youtu.be/Vc-ByDGOuQE";
        assert_eq!(clean_music_url(original), expected);
    }

    #[test]
    fn test_remove_si_parameter_youtube_music() {
        let original = "https://music.youtube.com/watch?v=nmYDYalgb5w&si=GGi18ac_fxnx4F1b";
        let expected = "https://music.youtube.com/watch?v=nmYDYalgb5w";
        assert_eq!(clean_music_url(original), expected);
    }

    #[test]
    fn test_remove_si_parameter_spotify() {
        let original = "https://open.spotify.com/track/1FYWnRofuIgJf62AnX8i5S?si=bf00147df50f4141";
        let expected = "https://open.spotify.com/track/1FYWnRofuIgJf62AnX8i5S";
        assert_eq!(clean_music_url(original), expected);
    }

    #[test]
    fn test_remove_si_parameter_with_multiple_params() {
        let original = "https://music.youtube.com/watch?v=nmYDYalgb5w&si=GGi18ac_fxnx4F1b&list=RDAMVMnmYDYalgb5w";
        let expected = "https://music.youtube.com/watch?v=nmYDYalgb5w&list=RDAMVMnmYDYalgb5w";
        assert_eq!(clean_music_url(original), expected);
    }

    #[test]
    fn test_extract_music_links_from_mobile_youtube() {
        let text = "https://m.youtube.com/watch?v=O36ynEi9TDw&si=abc123";
        let links = extract_music_links(text);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].platform, MusicPlatform::YouTube);
        assert_eq!(
            links[0].cleaned,
            "https://m.youtube.com/watch?v=O36ynEi9TDw"
        );
    }

    #[test]
    fn test_music_link_tracking_flag() {
        let with_tracking = "https://music.youtube.com/watch?v=_F6lmHi7R7s&si=3S6ssv34qqXqffvK";
        let without_tracking = "https://music.youtube.com/watch?v=_F6lmHi7R7s";
        let links = extract_music_links(&format!("{with_tracking} {without_tracking}"));
        assert_eq!(links.len(), 2);
        assert!(links[0].had_tracking);
        assert!(!links[1].had_tracking);
    }

    #[test]
    fn test_clean_music_url_keeps_apple_track_id() {
        let original =
            "https://music.apple.com/kr/album/foo/123456789?i=987654321&ls=1&itsct=abc123";
        let expected = "https://music.apple.com/kr/album/foo/123456789?i=987654321";
        assert_eq!(clean_music_url(original), expected);
    }

    #[test]
    fn test_convert_x_links_rewrites_host_and_strips_query() {
        let text = "https://x.com/lettuce9094/status/1997610286262718819?s=20";
        let pairs = convert_x_links(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(
            pairs[0].converted,
            "https://fxtwitter.com/lettuce9094/status/1997610286262718819"
        );
        assert_eq!(
            pairs[0].cleaned_original,
            "https://x.com/lettuce9094/status/1997610286262718819"
        );
        assert!(!pairs[0].disable_preview);
        assert_eq!(
            pairs[0].original,
            "https://x.com/lettuce9094/status/1997610286262718819?s=20"
        );
    }

    #[test]
    fn test_convert_x_links_with_dot_prefix_disables_preview_and_strips_dot() {
        let text = ".https://x.com/user/status/12345?s=99";
        let pairs = convert_x_links(text);
        assert_eq!(pairs.len(), 1);
        assert!(pairs[0].disable_preview);
        assert_eq!(
            pairs[0].converted,
            "https://fxtwitter.com/user/status/12345"
        );
        assert_eq!(pairs[0].cleaned_original, "https://x.com/user/status/12345");
        assert_eq!(pairs[0].original, ".https://x.com/user/status/12345?s=99");
    }

    #[test]
    fn test_convert_instagram_links_rewrites_host_and_strips_query() {
        let text = "https://www.instagram.com/p/DR_uVJVklbf/?utm_source=ig_web_copy_link&igsh=Nm9hazRuaXNrdGo1";
        let pairs = convert_instagram_links(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].converted, "https://vxinstagram.com/p/DR_uVJVklbf/");
        assert_eq!(
            pairs[0].cleaned_original,
            "https://www.instagram.com/p/DR_uVJVklbf/"
        );
    }

    #[test]
    fn test_convert_threads_post_links_rewrites_host_and_strips_query() {
        let text = "https://www.threads.com/@meta/post/DG7ABCDxyz1?igshid=test";
        let pairs = convert_threads_links(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(
            pairs[0].converted,
            "https://www.threads.com/@meta/post/DG7ABCDxyz1"
        );
        assert_eq!(
            pairs[0].cleaned_original,
            "https://www.threads.com/@meta/post/DG7ABCDxyz1"
        );
    }

    #[test]
    fn test_convert_threads_share_links_rewrites_threads_net() {
        let text = "https://threads.net/t/DWLAqGNknz8?xmt=AQGz";
        let pairs = convert_threads_links(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(pairs[0].converted, "https://threads.net/t/DWLAqGNknz8");
        assert_eq!(
            pairs[0].cleaned_original,
            "https://threads.net/t/DWLAqGNknz8"
        );
    }

    #[test]
    fn test_convert_threads_links_keeps_non_tracking_query() {
        let text = "https://threads.net/t/DWLAqGNknz8?foo=bar&xmt=AQGz#section";
        let pairs = convert_threads_links(text);
        assert_eq!(pairs.len(), 1);
        assert_eq!(
            pairs[0].converted,
            "https://threads.net/t/DWLAqGNknz8?foo=bar"
        );
    }

    #[test]
    fn test_threads_links_without_tracking_are_ignored() {
        let text = "https://www.threads.com/@meta/post/DG7ABCDxyz1";
        assert!(contains_threads_link(text));
        assert!(convert_threads_links(text).is_empty());
    }

    #[test]
    fn test_threads_profile_only_links_are_ignored() {
        let text = "https://www.threads.com/@meta";
        assert!(!contains_threads_link(text));
        assert!(convert_threads_links(text).is_empty());
    }
}
