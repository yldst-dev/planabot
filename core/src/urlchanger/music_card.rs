use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow};
use log::{info, warn};
use once_cell::sync::Lazy;
use resvg::tiny_skia;
use resvg::usvg;
use resvg::usvg::fontdb;
use tokio::time::timeout;

use super::link_utils::{MusicLink, MusicPlatform};
use super::music_metadata::{download_cover, fetch_music_metadata};

pub const CARD_WIDTH: u32 = 1200;
pub const CARD_HEIGHT: u32 = 600;

const COVER_ORIGIN: f32 = 80.0;
const COVER_SIZE: f32 = 440.0;
const COVER_RADIUS: f32 = 20.0;
const TEXT_X: f32 = 584.0;
const TEXT_MAX_WIDTH: f32 = 544.0;
const CENTER_Y: f32 = 300.0;
const TITLE_SIZE: f32 = 56.0;
const TITLE_LINE_HEIGHT: f32 = 68.0;
const TITLE_ASCENT: f32 = 52.0;
const TITLE_MAX_LINES: usize = 2;
const ARTIST_SIZE: f32 = 34.0;
const ARTIST_BLOCK: f32 = 60.0;
const ARTIST_ASCENT: f32 = 44.0;
const LABEL_SIZE: f32 = 24.0;
const LABEL_BASELINE: f32 = 496.0;
const COVER_HREF: &str = "cover";
const ELLIPSIS: &str = "…";

const DEFAULT_FONT_DIR: &str = "/usr/share/fonts";
const DEFAULT_FONT_FAMILY: &str = "Noto Sans CJK KR";
const FONT_DIR_ENV: &str = "PLANABOT_MUSIC_CARD_FONT_DIR";
const FONT_FAMILY_ENV: &str = "PLANABOT_MUSIC_CARD_FONT_FAMILY";
const ENABLED_ENV: &str = "PLANABOT_MUSIC_CARD_ENABLED";
const FONT_DIR_MAX_DEPTH: usize = 4;
const PIPELINE_TIMEOUT: Duration = Duration::from_secs(15);

struct FontSetup {
    db: Arc<fontdb::Database>,
    family: String,
}

static FONT_SETUP: Lazy<Option<FontSetup>> = Lazy::new(load_font_setup);

pub struct CardContent {
    pub title: String,
    pub artist: Option<String>,
    pub platform: MusicPlatform,
    pub cover: Vec<u8>,
}

pub fn is_enabled() -> bool {
    match std::env::var(ENABLED_ENV) {
        Ok(raw) => !matches!(
            raw.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        ),
        Err(_) => true,
    }
}

pub fn supports_card(platform: MusicPlatform) -> bool {
    matches!(
        platform,
        MusicPlatform::Spotify | MusicPlatform::YouTubeMusic | MusicPlatform::AppleMusic
    )
}

pub async fn build_music_card(links: &[MusicLink]) -> Option<Vec<u8>> {
    if !is_enabled() {
        return None;
    }
    let link = links.iter().find(|link| supports_card(link.platform))?;
    match timeout(PIPELINE_TIMEOUT, build_for_link(link)).await {
        Ok(Ok(png)) => Some(png),
        Ok(Err(err)) => {
            warn!("음악 카드 생성 실패({}): {:#}", link.cleaned, err);
            None
        }
        Err(_) => {
            warn!("음악 카드 생성 시간 초과: {}", link.cleaned);
            None
        }
    }
}

async fn build_for_link(link: &MusicLink) -> Result<Vec<u8>> {
    let metadata = fetch_music_metadata(link).await?;
    let cover = download_cover(&metadata.cover_url).await?;
    let content = CardContent {
        title: metadata.title,
        artist: metadata.artist,
        platform: link.platform,
        cover,
    };
    tokio::task::spawn_blocking(move || render_card(&content))
        .await
        .context("음악 카드 렌더링 작업이 중단되었습니다")?
}

pub fn render_card(content: &CardContent) -> Result<Vec<u8>> {
    let setup = FONT_SETUP
        .as_ref()
        .ok_or_else(|| anyhow!("음악 카드 폰트를 불러오지 못했습니다"))?;
    let fonts = &setup.db;
    let family = setup.family.as_str();

    let measure_title = |text: &str| measure_width(fonts, family, 700, TITLE_SIZE, text);
    let measure_artist = |text: &str| measure_width(fonts, family, 400, ARTIST_SIZE, text);
    let title_lines = wrap_lines(
        &content.title,
        TEXT_MAX_WIDTH,
        TITLE_MAX_LINES,
        &measure_title,
    );
    let artist_line = content
        .artist
        .as_deref()
        .map(|artist| truncate_with_ellipsis(artist, TEXT_MAX_WIDTH, &measure_artist))
        .filter(|artist| !artist.is_empty());

    let svg = card_svg(
        family,
        &title_lines,
        artist_line.as_deref(),
        content.platform,
    );
    let cover_kind = image_kind(Arc::new(content.cover.clone()))?;

    let options = usvg::Options {
        fontdb: Arc::clone(fonts),
        font_family: family.to_string(),
        image_href_resolver: usvg::ImageHrefResolver {
            resolve_data: usvg::ImageHrefResolver::default_data_resolver(),
            resolve_string: Box::new(move |href: &str, _: &usvg::Options| {
                (href == COVER_HREF).then(|| cover_kind.clone())
            }),
        },
        ..usvg::Options::default()
    };

    let tree = usvg::Tree::from_str(&svg, &options).context("음악 카드 SVG 파싱 실패")?;
    let mut pixmap = tiny_skia::Pixmap::new(CARD_WIDTH, CARD_HEIGHT)
        .ok_or_else(|| anyhow!("음악 카드 픽스맵 생성 실패"))?;
    resvg::render(
        &tree,
        tiny_skia::Transform::identity(),
        &mut pixmap.as_mut(),
    );
    pixmap.encode_png().context("음악 카드 PNG 인코딩 실패")
}

fn image_kind(bytes: Arc<Vec<u8>>) -> Result<usvg::ImageKind> {
    let head = bytes.as_slice();
    if head.starts_with(&[0xFF, 0xD8]) {
        Ok(usvg::ImageKind::JPEG(bytes))
    } else if head.starts_with(&[0x89, b'P', b'N', b'G']) {
        Ok(usvg::ImageKind::PNG(bytes))
    } else if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WEBP" {
        Ok(usvg::ImageKind::WEBP(bytes))
    } else if head.starts_with(b"GIF8") {
        Ok(usvg::ImageKind::GIF(bytes))
    } else {
        Err(anyhow!("지원하지 않는 표지 이미지 형식"))
    }
}

fn card_svg(
    family: &str,
    title_lines: &[String],
    artist: Option<&str>,
    platform: MusicPlatform,
) -> String {
    let line_count = title_lines.len().max(1) as f32;
    let artist_block = if artist.is_some() { ARTIST_BLOCK } else { 0.0 };
    let block_height = line_count * TITLE_LINE_HEIGHT + artist_block;
    let top = CENTER_Y - block_height / 2.0 + 8.0;

    let mut text_nodes = String::new();
    for (index, line) in title_lines.iter().enumerate() {
        let baseline = top + TITLE_ASCENT + index as f32 * TITLE_LINE_HEIGHT;
        text_nodes.push_str(&format!(
            r#"<text x="{TEXT_X}" y="{baseline:.1}" font-size="{TITLE_SIZE}" font-weight="700">{}</text>"#,
            escape_xml(line)
        ));
    }
    if let Some(artist) = artist {
        let baseline = top + line_count * TITLE_LINE_HEIGHT + ARTIST_ASCENT;
        text_nodes.push_str(&format!(
            r#"<text x="{TEXT_X}" y="{baseline:.1}" font-size="{ARTIST_SIZE}" fill-opacity="0.82">{}</text>"#,
            escape_xml(artist)
        ));
    }

    let dot_x = TEXT_X + 12.0;
    let label_x = TEXT_X + 36.0;
    let dot_y = LABEL_BASELINE - 10.0;
    let bg_size = 1500.0;
    let bg_x = (CARD_WIDTH as f32 - bg_size) / 2.0;
    let bg_y = (CARD_HEIGHT as f32 - bg_size) / 2.0;

    format!(
        r##"<svg xmlns="http://www.w3.org/2000/svg" width="{CARD_WIDTH}" height="{CARD_HEIGHT}" viewBox="0 0 {CARD_WIDTH} {CARD_HEIGHT}">
<defs>
<filter id="bg-blur" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="48"/></filter>
<clipPath id="cover-clip"><rect x="{COVER_ORIGIN}" y="{COVER_ORIGIN}" width="{COVER_SIZE}" height="{COVER_SIZE}" rx="{COVER_RADIUS}"/></clipPath>
<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000000" stop-opacity="0.38"/><stop offset="1" stop-color="#000000" stop-opacity="0.74"/></linearGradient>
</defs>
<rect width="{CARD_WIDTH}" height="{CARD_HEIGHT}" fill="#141414"/>
<image href="{COVER_HREF}" x="{bg_x}" y="{bg_y}" width="{bg_size}" height="{bg_size}" preserveAspectRatio="xMidYMid slice" filter="url(#bg-blur)"/>
<rect width="{CARD_WIDTH}" height="{CARD_HEIGHT}" fill="url(#shade)"/>
<image href="{COVER_HREF}" x="{COVER_ORIGIN}" y="{COVER_ORIGIN}" width="{COVER_SIZE}" height="{COVER_SIZE}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cover-clip)"/>
<g font-family="{family}" fill="#ffffff">
{text_nodes}
<circle cx="{dot_x}" cy="{dot_y}" r="8" fill="{accent}"/>
<text x="{label_x}" y="{LABEL_BASELINE}" font-size="{LABEL_SIZE}" letter-spacing="3" fill-opacity="0.7">{label}</text>
</g>
</svg>"##,
        family = escape_xml(family),
        accent = platform_accent(platform),
        label = platform_label(platform),
    )
}

fn platform_label(platform: MusicPlatform) -> &'static str {
    match platform {
        MusicPlatform::Spotify => "SPOTIFY",
        MusicPlatform::YouTubeMusic => "YOUTUBE MUSIC",
        MusicPlatform::YouTube => "YOUTUBE",
        MusicPlatform::AppleMusic => "APPLE MUSIC",
    }
}

fn platform_accent(platform: MusicPlatform) -> &'static str {
    match platform {
        MusicPlatform::Spotify => "#1DB954",
        MusicPlatform::YouTubeMusic | MusicPlatform::YouTube => "#FF0033",
        MusicPlatform::AppleMusic => "#FA243C",
    }
}

fn escape_xml(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn measure_width(
    fonts: &Arc<fontdb::Database>,
    family: &str,
    weight: u16,
    size: f32,
    text: &str,
) -> f32 {
    if text.trim().is_empty() {
        return 0.0;
    }
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><text x="0" y="0" font-family="{}" font-weight="{weight}" font-size="{size}">{}</text></svg>"#,
        escape_xml(family),
        escape_xml(text)
    );
    let options = usvg::Options {
        fontdb: Arc::clone(fonts),
        ..usvg::Options::default()
    };
    match usvg::Tree::from_str(&svg, &options) {
        Ok(tree) => tree.root().bounding_box().width(),
        Err(_) => f32::INFINITY,
    }
}

fn wrap_lines(
    text: &str,
    max_width: f32,
    max_lines: usize,
    measure: &dyn Fn(&str) -> f32,
) -> Vec<String> {
    let normalized = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.is_empty() {
        return vec![String::new()];
    }
    let chars: Vec<char> = normalized.chars().collect();
    let mut lines = Vec::new();
    let mut start = 0;
    while start < chars.len() {
        let rest: String = chars[start..].iter().collect();
        if lines.len() + 1 >= max_lines {
            lines.push(truncate_with_ellipsis(&rest, max_width, measure));
            return lines;
        }
        let end = line_break_index(&chars, start, max_width, measure);
        let line: String = chars[start..end].iter().collect();
        lines.push(line.trim().to_string());
        start = end;
        while start < chars.len() && chars[start] == ' ' {
            start += 1;
        }
    }
    lines
}

fn line_break_index(
    chars: &[char],
    start: usize,
    max_width: f32,
    measure: &dyn Fn(&str) -> f32,
) -> usize {
    let fits = |end: usize| {
        let candidate: String = chars[start..end].iter().collect();
        measure(candidate.trim_end()) <= max_width
    };
    if fits(chars.len()) {
        return chars.len();
    }
    let mut low = start + 1;
    let mut high = chars.len() - 1;
    while low < high {
        let mid = (low + high).div_ceil(2);
        if fits(mid) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    let end = low;
    (start + 1..=end)
        .rev()
        .find(|index| chars[*index] == ' ')
        .unwrap_or(end)
}

fn truncate_with_ellipsis(text: &str, max_width: f32, measure: &dyn Fn(&str) -> f32) -> String {
    let trimmed = text.trim();
    if measure(trimmed) <= max_width {
        return trimmed.to_string();
    }
    let chars: Vec<char> = trimmed.chars().collect();
    let candidate = |count: usize| {
        let prefix: String = chars[..count].iter().collect();
        format!("{}{ELLIPSIS}", prefix.trim_end())
    };
    let mut low = 0;
    let mut high = chars.len();
    while low < high {
        let mid = (low + high).div_ceil(2);
        if measure(&candidate(mid)) <= max_width {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    candidate(low)
}

fn load_font_setup() -> Option<FontSetup> {
    let dir = std::env::var(FONT_DIR_ENV)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(DEFAULT_FONT_DIR));
    let mut db = fontdb::Database::new();
    let mut loaded = 0usize;
    for path in collect_font_files(&dir, FONT_DIR_MAX_DEPTH) {
        match std::fs::read(&path) {
            Ok(data) => {
                db.load_font_data(data);
                loaded += 1;
            }
            Err(err) => warn!("음악 카드 폰트 읽기 실패({}): {}", path.display(), err),
        }
    }
    if loaded == 0 || db.is_empty() {
        warn!(
            "음악 카드 폰트를 찾지 못해 카드 전송을 건너뜁니다: {}",
            dir.display()
        );
        return None;
    }
    let family = resolve_family(&db);
    info!(
        "음악 카드 폰트 로드 완료: 파일 {}개, 페이스 {}개, 기본 서체 {}",
        loaded,
        db.len(),
        family
    );
    Some(FontSetup {
        db: Arc::new(db),
        family,
    })
}

fn collect_font_files(dir: &Path, depth: usize) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return files;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth > 0 {
                files.extend(collect_font_files(&path, depth - 1));
            }
            continue;
        }
        let is_font = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                matches!(
                    ext.to_ascii_lowercase().as_str(),
                    "ttf" | "otf" | "ttc" | "otc"
                )
            })
            .unwrap_or(false);
        if is_font {
            files.push(path);
        }
    }
    files.sort();
    files
}

fn resolve_family(db: &fontdb::Database) -> String {
    let preferred = std::env::var(FONT_FAMILY_ENV)
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_FONT_FAMILY.to_string());
    let available = db
        .faces()
        .any(|face| face.families.iter().any(|(name, _)| name == &preferred));
    if available {
        return preferred;
    }
    match db
        .faces()
        .find_map(|face| face.families.first().map(|(name, _)| name.clone()))
    {
        Some(fallback) => {
            warn!(
                "음악 카드 서체 '{}'를 찾지 못해 '{}'를 사용합니다",
                preferred, fallback
            );
            fallback
        }
        None => preferred,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn char_measure(text: &str) -> f32 {
        text.chars().count() as f32 * 10.0
    }

    #[test]
    fn wrap_lines_prefers_word_boundaries_and_truncates_last_line() {
        let lines = wrap_lines("hello world foo", 50.0, 2, &char_measure);
        assert_eq!(lines, vec!["hello".to_string(), "worl…".to_string()]);
    }

    #[test]
    fn wrap_lines_breaks_cjk_without_spaces() {
        let lines = wrap_lines("가나다라마바사", 50.0, 2, &char_measure);
        assert_eq!(lines, vec!["가나다라마".to_string(), "바사".to_string()]);
    }

    #[test]
    fn wrap_lines_keeps_short_text_on_one_line() {
        let lines = wrap_lines("  hello   world ", 200.0, 2, &char_measure);
        assert_eq!(lines, vec!["hello world".to_string()]);
    }

    #[test]
    fn wrap_lines_handles_empty_text() {
        assert_eq!(
            wrap_lines("   ", 50.0, 2, &char_measure),
            vec![String::new()]
        );
    }

    #[test]
    fn truncate_with_ellipsis_fits_within_width() {
        assert_eq!(
            truncate_with_ellipsis("abcdefghij", 50.0, &char_measure),
            "abcd…"
        );
        assert_eq!(truncate_with_ellipsis("abc", 50.0, &char_measure), "abc");
        assert_eq!(truncate_with_ellipsis("abcdef", 5.0, &char_measure), "…");
    }

    #[test]
    fn card_svg_escapes_text_and_places_lines() {
        let svg = card_svg(
            "Test Family",
            &["A & B".to_string(), "<second>".to_string()],
            Some("Artist \"Q\""),
            MusicPlatform::Spotify,
        );
        assert!(svg.contains("A &amp; B"));
        assert!(svg.contains("&lt;second&gt;"));
        assert!(svg.contains("Artist &quot;Q&quot;"));
        assert!(svg.contains("SPOTIFY"));
        assert!(svg.contains("#1DB954"));
        assert_eq!(svg.matches("<text").count(), 4);
    }

    #[test]
    fn image_kind_detects_common_formats() {
        assert!(matches!(
            image_kind(Arc::new(vec![0xFF, 0xD8, 0xFF, 0xE0])),
            Ok(usvg::ImageKind::JPEG(_))
        ));
        assert!(matches!(
            image_kind(Arc::new(vec![0x89, b'P', b'N', b'G', 0x0D])),
            Ok(usvg::ImageKind::PNG(_))
        ));
        assert!(image_kind(Arc::new(b"<html>".to_vec())).is_err());
    }

    #[test]
    fn supports_card_excludes_plain_youtube() {
        assert!(supports_card(MusicPlatform::Spotify));
        assert!(supports_card(MusicPlatform::YouTubeMusic));
        assert!(supports_card(MusicPlatform::AppleMusic));
        assert!(!supports_card(MusicPlatform::YouTube));
    }

    #[tokio::test]
    #[ignore]
    async fn builds_cards_from_live_links() {
        use super::super::link_utils::extract_music_links;

        let output_dir = std::env::var("PLANABOT_MUSIC_CARD_TEST_OUTPUT_DIR").expect("output dir");
        let text = std::env::var("PLANABOT_MUSIC_CARD_TEST_URLS").unwrap_or_else(|_| {
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=abc \
https://music.youtube.com/watch?v=lYBUbBu4W08&si=def \
https://music.apple.com/jp/album/%E5%A4%9C%E3%81%AB%E9%A7%86%E3%81%91%E3%82%8B/1490256978?i=1490256995"
                .to_string()
        });
        let links = extract_music_links(&text);
        assert!(!links.is_empty());
        for link in &links {
            let started = std::time::Instant::now();
            let png = build_music_card(std::slice::from_ref(link))
                .await
                .unwrap_or_else(|| panic!("card for {}", link.cleaned));
            let name = format!("{:?}.png", link.platform).to_lowercase();
            eprintln!(
                "{}: {:?}, {} bytes",
                link.cleaned,
                started.elapsed(),
                png.len()
            );
            std::fs::write(std::path::Path::new(&output_dir).join(name), png).expect("write");
        }
    }

    #[test]
    #[ignore]
    fn renders_card_with_local_fonts() {
        let output = std::env::var("PLANABOT_MUSIC_CARD_TEST_OUTPUT").expect("output path");
        let cover_path = std::env::var("PLANABOT_MUSIC_CARD_TEST_COVER").expect("cover path");
        let cover = std::fs::read(cover_path).expect("cover bytes");
        let content = CardContent {
            title: "밤편지 (Through the Night) 아주 긴 제목이 두 줄을 넘길 때 말줄임 확인"
                .to_string(),
            artist: Some("아이유 (IU) · YOASOBI · アイドル".to_string()),
            platform: MusicPlatform::Spotify,
            cover,
        };
        let started = std::time::Instant::now();
        let png = render_card(&content).expect("render");
        eprintln!(
            "render elapsed: {:?}, {} bytes",
            started.elapsed(),
            png.len()
        );
        std::fs::write(output, png).expect("write output");
    }
}
