use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Deserialize;
use url::Url;

use super::link_utils::{MusicLink, MusicPlatform};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(6);
const MAX_PAGE_BYTES: usize = 3 * 1024 * 1024;
const MAX_COVER_BYTES: usize = 5 * 1024 * 1024;
const USER_AGENT: &str = "Mozilla/5.0 (compatible; planabot/0.1)";

static CLIENT: Lazy<reqwest::Client> = Lazy::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .user_agent(USER_AGENT)
        .build()
        .unwrap_or_default()
});
static META_TAG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?is)<meta\b[^>]*>").unwrap());
static META_ATTR_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r#"(?is)\b(property|name|content)\s*=\s*"([^"]*)""#).unwrap());

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MusicMetadata {
    pub title: String,
    pub artist: Option<String>,
    pub cover_url: String,
}

pub async fn fetch_music_metadata(link: &MusicLink) -> Result<MusicMetadata> {
    let url = Url::parse(&link.cleaned).context("음악 링크 파싱 실패")?;
    match link.platform {
        MusicPlatform::Spotify => fetch_spotify(&url).await,
        MusicPlatform::YouTubeMusic | MusicPlatform::YouTube => fetch_youtube(&url).await,
        MusicPlatform::AppleMusic => fetch_apple(&url).await,
    }
}

pub async fn download_cover(cover_url: &str) -> Result<Vec<u8>> {
    let url = Url::parse(cover_url).context("표지 URL 파싱 실패")?;
    let host = url.host_str().unwrap_or_default();
    if url.scheme() != "https" || !is_allowed_cover_host(host) {
        bail!("허용되지 않은 표지 호스트: {}", host);
    }
    let response = CLIENT.get(url).send().await?.error_for_status()?;
    let bytes = read_body_limited(response, MAX_COVER_BYTES).await?;
    if bytes.is_empty() {
        bail!("표지 응답이 비어 있습니다");
    }
    Ok(bytes)
}

fn is_allowed_cover_host(host: &str) -> bool {
    host == "i.scdn.co"
        || host == "i.ytimg.com"
        || host.ends_with(".spotifycdn.com")
        || host.ends_with(".mzstatic.com")
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
    Ok(buf)
}

async fn fetch_text(url: Url) -> Result<String> {
    let response = CLIENT.get(url).send().await?.error_for_status()?;
    let bytes = read_body_limited(response, MAX_PAGE_BYTES).await?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SpotifyTarget {
    kind: String,
    id: String,
}

fn spotify_target(url: &Url) -> Option<SpotifyTarget> {
    let mut segments = url.path_segments()?.filter(|segment| !segment.is_empty());
    let mut kind = segments.next()?;
    if kind.starts_with("intl-") {
        kind = segments.next()?;
    }
    if !matches!(
        kind,
        "track" | "album" | "playlist" | "artist" | "episode" | "show"
    ) {
        return None;
    }
    let id = segments.next()?;
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(SpotifyTarget {
        kind: kind.to_string(),
        id: id.to_string(),
    })
}

async fn fetch_spotify(url: &Url) -> Result<MusicMetadata> {
    let target =
        spotify_target(url).ok_or_else(|| anyhow!("지원하지 않는 스포티파이 경로: {url}"))?;
    let page_url = Url::parse(&format!(
        "https://open.spotify.com/{}/{}",
        target.kind, target.id
    ))?;
    let html = fetch_text(page_url).await?;
    parse_spotify_page(&html)
        .ok_or_else(|| anyhow!("스포티파이 페이지에서 메타데이터를 찾지 못했습니다"))
}

fn parse_spotify_page(html: &str) -> Option<MusicMetadata> {
    let meta = collect_og_meta(html);
    let title = clean_spotify_title(meta.get("og:title")?);
    if title.is_empty() {
        return None;
    }
    let cover_url = meta.get("og:image")?.clone();
    let artist = meta
        .get("og:description")
        .and_then(|description| artist_from_description(description))
        .filter(|artist| artist != &title);
    Some(MusicMetadata {
        title,
        artist,
        cover_url,
    })
}

fn clean_spotify_title(raw: &str) -> String {
    let trimmed = raw.trim().trim_end_matches("| Spotify").trim();
    for marker in [
        " - Album by ",
        " - Single by ",
        " - EP by ",
        " - Playlist by ",
        " - playlist by ",
    ] {
        if let Some(index) = trimmed.find(marker) {
            return trimmed[..index].trim().to_string();
        }
    }
    trimmed.to_string()
}

fn artist_from_description(description: &str) -> Option<String> {
    let first = description.split(" · ").next()?.trim();
    if first.is_empty() {
        None
    } else {
        Some(first.to_string())
    }
}

fn collect_og_meta(html: &str) -> HashMap<String, String> {
    let mut meta = HashMap::new();
    for tag in META_TAG_RE.find_iter(html) {
        let mut key = None;
        let mut content = None;
        for attr in META_ATTR_RE.captures_iter(tag.as_str()) {
            let name = attr[1].to_ascii_lowercase();
            let value = attr[2].to_string();
            match name.as_str() {
                "property" | "name" => {
                    if key.is_none() {
                        key = Some(value);
                    }
                }
                _ => content = Some(value),
            }
        }
        if let Some((key, content)) = key.zip(content).filter(|(key, _)| key.starts_with("og:")) {
            meta.entry(key).or_insert_with(|| unescape_html(&content));
        }
    }
    meta
}

fn unescape_html(raw: &str) -> String {
    raw.replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

fn youtube_video_id(url: &Url) -> Option<String> {
    let host = url.host_str()?;
    let id = if host == "youtu.be" {
        url.path_segments()?.next().map(str::to_string)
    } else {
        url.query_pairs()
            .find(|(key, _)| key == "v")
            .map(|(_, value)| value.into_owned())
            .or_else(|| {
                let mut segments = url.path_segments()?;
                match segments.next()? {
                    "shorts" | "embed" | "live" | "v" => segments.next().map(str::to_string),
                    _ => None,
                }
            })
    }?;
    is_valid_video_id(&id).then_some(id)
}

fn is_valid_video_id(id: &str) -> bool {
    id.len() == 11
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

#[derive(Debug, Deserialize)]
struct YoutubeOembed {
    title: String,
    author_name: Option<String>,
}

async fn fetch_youtube(url: &Url) -> Result<MusicMetadata> {
    let id =
        youtube_video_id(url).ok_or_else(|| anyhow!("유튜브 영상 ID를 찾지 못했습니다: {url}"))?;
    let mut oembed_url = Url::parse("https://www.youtube.com/oembed")?;
    oembed_url
        .query_pairs_mut()
        .append_pair("url", &format!("https://www.youtube.com/watch?v={id}"))
        .append_pair("format", "json");
    let payload: YoutubeOembed = CLIENT
        .get(oembed_url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("유튜브 oEmbed 응답 파싱 실패")?;
    let title = payload.title.trim().to_string();
    if title.is_empty() {
        bail!("유튜브 제목이 비어 있습니다");
    }
    let artist = payload
        .author_name
        .map(|author| strip_topic_suffix(&author))
        .filter(|author| !author.is_empty());
    let cover_url = pick_youtube_thumbnail(&id).await;
    Ok(MusicMetadata {
        title,
        artist,
        cover_url,
    })
}

async fn pick_youtube_thumbnail(id: &str) -> String {
    let maxres = format!("https://i.ytimg.com/vi/{id}/maxresdefault.jpg");
    match CLIENT.head(&maxres).send().await {
        Ok(response) if response.status().is_success() => maxres,
        _ => format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg"),
    }
}

fn strip_topic_suffix(author: &str) -> String {
    author
        .trim()
        .trim_end_matches(" - Topic")
        .trim()
        .to_string()
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct AppleTarget {
    id: String,
    storefront: String,
}

fn apple_target(url: &Url) -> Option<AppleTarget> {
    let segments: Vec<&str> = url
        .path_segments()?
        .filter(|segment| !segment.is_empty())
        .collect();
    let kind = segments
        .iter()
        .find(|segment| matches!(**segment, "album" | "song" | "music-video"))?;
    let storefront = segments
        .first()
        .filter(|segment| *segment != kind && segment.len() == 2)
        .map(|segment| segment.to_ascii_lowercase())
        .unwrap_or_else(|| "us".to_string());
    let track_id = url
        .query_pairs()
        .find(|(key, _)| key == "i")
        .map(|(_, value)| value.into_owned())
        .filter(|value| is_numeric_id(value));
    let path_id = segments
        .last()
        .filter(|segment| is_numeric_id(segment))
        .map(|segment| segment.to_string());
    let id = track_id.or(path_id)?;
    Some(AppleTarget { id, storefront })
}

fn is_numeric_id(value: &str) -> bool {
    !value.is_empty() && value.chars().all(|c| c.is_ascii_digit())
}

#[derive(Debug, Deserialize)]
struct ItunesLookup {
    results: Vec<ItunesEntry>,
}

#[derive(Debug, Deserialize)]
struct ItunesEntry {
    #[serde(rename = "trackName")]
    track_name: Option<String>,
    #[serde(rename = "collectionName")]
    collection_name: Option<String>,
    #[serde(rename = "artistName")]
    artist_name: Option<String>,
    #[serde(rename = "artworkUrl100")]
    artwork_url_100: Option<String>,
}

async fn fetch_apple(url: &Url) -> Result<MusicMetadata> {
    let target = apple_target(url).ok_or_else(|| anyhow!("지원하지 않는 애플 뮤직 경로: {url}"))?;
    let mut lookup_url = Url::parse("https://itunes.apple.com/lookup")?;
    lookup_url
        .query_pairs_mut()
        .append_pair("id", &target.id)
        .append_pair("country", &target.storefront);
    let payload: ItunesLookup = CLIENT
        .get(lookup_url)
        .send()
        .await?
        .error_for_status()?
        .json()
        .await
        .context("iTunes 조회 응답 파싱 실패")?;
    let entry = payload
        .results
        .into_iter()
        .next()
        .ok_or_else(|| anyhow!("iTunes 조회 결과가 없습니다: {}", target.id))?;
    apple_metadata_from_entry(entry)
        .ok_or_else(|| anyhow!("iTunes 조회 결과에 필요한 항목이 없습니다"))
}

fn apple_metadata_from_entry(entry: ItunesEntry) -> Option<MusicMetadata> {
    let title = entry
        .track_name
        .or(entry.collection_name)
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())?;
    let cover_url = apple_artwork_600(&entry.artwork_url_100?);
    let artist = entry
        .artist_name
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Some(MusicMetadata {
        title,
        artist,
        cover_url,
    })
}

fn apple_artwork_600(url: &str) -> String {
    url.replace("100x100bb", "600x600bb")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(url: &str) -> Url {
        Url::parse(url).unwrap()
    }

    #[test]
    fn spotify_target_reads_track_and_locale_prefix() {
        let plain = spotify_target(&parse(
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
        ));
        assert_eq!(
            plain,
            Some(SpotifyTarget {
                kind: "track".into(),
                id: "4cOdK2wGLETKBW3PvgPWqT".into()
            })
        );
        let localized = spotify_target(&parse(
            "https://open.spotify.com/intl-ko/album/5Z9iiGl2FcIfa3BMiv6OIw",
        ));
        assert_eq!(localized.map(|t| t.kind), Some("album".to_string()));
    }

    #[test]
    fn spotify_target_rejects_unknown_paths_and_bad_ids() {
        assert!(spotify_target(&parse("https://open.spotify.com/user/abc")).is_none());
        assert!(spotify_target(&parse("https://open.spotify.com/track/../etc")).is_none());
        assert!(spotify_target(&parse("https://open.spotify.com/track/")).is_none());
    }

    #[test]
    fn parse_spotify_page_extracts_title_artist_and_cover() {
        let html = r#"<html><head>
<meta property="og:title" content="Never Gonna Give You Up"/>
<meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987"/>
<meta content="https://i.scdn.co/image/abc" property="og:image"/>
<meta property="og:type" content="music.song"/>
</head></html>"#;
        let meta = parse_spotify_page(html).unwrap();
        assert_eq!(meta.title, "Never Gonna Give You Up");
        assert_eq!(meta.artist.as_deref(), Some("Rick Astley"));
        assert_eq!(meta.cover_url, "https://i.scdn.co/image/abc");
    }

    #[test]
    fn parse_spotify_page_unescapes_entities_and_cleans_album_title() {
        let html = r#"<meta property="og:title" content="Tom&#39;s Diner &amp; More - Album by Suzanne Vega | Spotify">
<meta property="og:description" content="Suzanne Vega · album · 1987 · 10 songs">
<meta property="og:image" content="https://i.scdn.co/image/def">"#;
        let meta = parse_spotify_page(html).unwrap();
        assert_eq!(meta.title, "Tom's Diner & More");
        assert_eq!(meta.artist.as_deref(), Some("Suzanne Vega"));
    }

    #[test]
    fn parse_spotify_page_requires_title_and_image() {
        let html = r#"<meta property="og:title" content="Only Title">"#;
        assert!(parse_spotify_page(html).is_none());
    }

    #[test]
    fn youtube_video_id_handles_watch_short_and_music_urls() {
        assert_eq!(
            youtube_video_id(&parse(
                "https://music.youtube.com/watch?v=nmYDYalgb5w&list=RD"
            )),
            Some("nmYDYalgb5w".into())
        );
        assert_eq!(
            youtube_video_id(&parse("https://youtu.be/Vc-ByDGOuQE")),
            Some("Vc-ByDGOuQE".into())
        );
        assert_eq!(
            youtube_video_id(&parse("https://www.youtube.com/shorts/dQw4w9WgXcQ")),
            Some("dQw4w9WgXcQ".into())
        );
        assert!(
            youtube_video_id(&parse("https://music.youtube.com/playlist?list=PL123")).is_none()
        );
        assert!(youtube_video_id(&parse("https://www.youtube.com/watch?v=<script>")).is_none());
    }

    #[test]
    fn strip_topic_suffix_removes_auto_channel_marker() {
        assert_eq!(strip_topic_suffix("Rick Astley - Topic"), "Rick Astley");
        assert_eq!(strip_topic_suffix("YOASOBI"), "YOASOBI");
    }

    #[test]
    fn apple_target_prefers_track_id_and_reads_storefront() {
        let target = apple_target(&parse(
            "https://music.apple.com/kr/album/foo/123456789?i=987654321",
        ))
        .unwrap();
        assert_eq!(target.id, "987654321");
        assert_eq!(target.storefront, "kr");

        let album = apple_target(&parse("https://music.apple.com/jp/album/foo/123456789")).unwrap();
        assert_eq!(album.id, "123456789");
        assert_eq!(album.storefront, "jp");

        let no_storefront =
            apple_target(&parse("https://music.apple.com/album/foo/123456789")).unwrap();
        assert_eq!(no_storefront.storefront, "us");
    }

    #[test]
    fn apple_target_rejects_playlists_and_artists() {
        assert!(apple_target(&parse("https://music.apple.com/kr/playlist/foo/pl.abc")).is_none());
        assert!(apple_target(&parse("https://music.apple.com/kr/artist/foo/123")).is_none());
    }

    #[test]
    fn apple_metadata_uses_track_name_and_upscales_artwork() {
        let entry = ItunesEntry {
            track_name: Some("夜に駆ける".into()),
            collection_name: Some("夜に駆ける - Single".into()),
            artist_name: Some("YOASOBI".into()),
            artwork_url_100: Some("https://is1-ssl.mzstatic.com/image/a/100x100bb.jpg".into()),
        };
        let meta = apple_metadata_from_entry(entry).unwrap();
        assert_eq!(meta.title, "夜に駆ける");
        assert_eq!(meta.artist.as_deref(), Some("YOASOBI"));
        assert_eq!(
            meta.cover_url,
            "https://is1-ssl.mzstatic.com/image/a/600x600bb.jpg"
        );
    }

    #[tokio::test]
    #[ignore]
    async fn fetches_live_metadata_for_each_platform() {
        let links = [
            (
                "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
                MusicPlatform::Spotify,
            ),
            (
                "https://music.youtube.com/watch?v=lYBUbBu4W08",
                MusicPlatform::YouTubeMusic,
            ),
            (
                "https://music.apple.com/jp/album/x/1490256978?i=1490256995",
                MusicPlatform::AppleMusic,
            ),
        ];
        let mut failures = Vec::new();
        for (url, platform) in links {
            let link = MusicLink {
                original: url.to_string(),
                cleaned: url.to_string(),
                platform,
                had_tracking: false,
            };
            match fetch_music_metadata(&link).await {
                Ok(meta) => {
                    eprintln!("{platform:?}: {meta:?}");
                    match download_cover(&meta.cover_url).await {
                        Ok(bytes) => eprintln!("  cover {} bytes", bytes.len()),
                        Err(err) => failures.push(format!("{platform:?} cover: {err:#}")),
                    }
                }
                Err(err) => failures.push(format!("{platform:?}: {err:#}")),
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn cover_host_allowlist_blocks_unknown_hosts() {
        assert!(is_allowed_cover_host("i.scdn.co"));
        assert!(is_allowed_cover_host("image-cdn-ak.spotifycdn.com"));
        assert!(is_allowed_cover_host("i.ytimg.com"));
        assert!(is_allowed_cover_host("is1-ssl.mzstatic.com"));
        assert!(!is_allowed_cover_host("example.com"));
        assert!(!is_allowed_cover_host("mzstatic.com.evil.test"));
    }
}
