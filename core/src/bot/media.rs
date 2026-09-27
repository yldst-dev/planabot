use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use log::warn;
use serde::{Deserialize, Serialize};
use teloxide::prelude::*;
use teloxide::types::{FileId, Message, PhotoSize, Sticker};
use tokio::fs;

use crate::planabrain;

pub(crate) const MAX_TURN_IMAGES: usize = 4;
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;
const LOW_DETAIL_EDGE: u32 = 512;
const MEDIA_GROUP_TTL: Duration = Duration::from_secs(30 * 60);
const MAX_MEDIA_GROUPS: usize = 256;

static DOWNLOAD_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ImageSource {
    pub file_id: String,
    pub mime_type: String,
}

impl ImageSource {
    fn new(file_id: &FileId, mime_type: &str) -> Self {
        Self {
            file_id: file_id.0.clone(),
            mime_type: mime_type.to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageSkip {
    TooLarge,
    Unsupported,
    Failed,
}

impl ImageSkip {
    pub(crate) fn notice(self) -> &'static str {
        match self {
            Self::TooLarge => "5MB를 넘는 이미지는 확인하지 않았습니다.",
            Self::Unsupported => {
                "지원하지 않는 형식의 이미지가 있습니다. JPEG, PNG, WebP, GIF만 볼 수 있습니다."
            }
            Self::Failed => "이미지를 내려받지 못했습니다.",
        }
    }
}

pub(crate) const RATE_LIMITED_NOTICE: &str =
    "요청이 잦아 이번 이미지는 확인하지 않았습니다. 1분쯤 뒤에 다시 보내면 확인할 수 있습니다.";

#[derive(Debug, Default)]
pub(crate) struct TurnImages {
    pub inputs: Vec<planabrain::ImageInput>,
    pub sources: Vec<ImageSource>,
    pub notice: Option<String>,
}

pub(crate) fn extract_image_source(msg: &Message) -> Option<ImageSource> {
    if let Some(photos) = msg.photo() {
        let photo = preferred_photo(photos, low_detail_enabled())?;
        return Some(ImageSource::new(&photo.file.id, "image/jpeg"));
    }
    if let Some(sticker) = msg.sticker() {
        return sticker_image_source(sticker);
    }
    if let Some(animation) = msg.animation() {
        return thumbnail_source(animation.thumbnail.as_ref());
    }
    if let Some(video) = msg.video() {
        return thumbnail_source(video.thumbnail.as_ref());
    }
    if let Some(note) = msg.video_note() {
        return thumbnail_source(note.thumbnail.as_ref());
    }
    let document = msg.document()?;
    let mime = document.mime_type.as_ref()?.essence_str();
    if mime.starts_with("image/") {
        return Some(ImageSource::new(&document.file.id, mime));
    }
    if mime.starts_with("video/") {
        return thumbnail_source(document.thumbnail.as_ref());
    }
    None
}

pub(crate) fn media_label(msg: &Message) -> Option<String> {
    if msg.photo().is_some() {
        return Some("(사진)".to_string());
    }
    if let Some(sticker) = msg.sticker() {
        return Some(match sticker.emoji.as_deref() {
            Some(emoji) => format!("(스티커 {emoji})"),
            None => "(스티커)".to_string(),
        });
    }
    if msg.animation().is_some() {
        return Some("(GIF)".to_string());
    }
    if msg.video().is_some() {
        return Some("(영상)".to_string());
    }
    if msg.video_note().is_some() {
        return Some("(영상 메시지)".to_string());
    }
    let document = msg.document()?;
    let is_video = document
        .mime_type
        .as_ref()
        .is_some_and(|mime| mime.type_() == "video");
    extract_image_source(msg).map(|_| {
        if is_video {
            "(영상)"
        } else {
            "(이미지 파일)"
        }
        .to_string()
    })
}

fn thumbnail_source(thumbnail: Option<&PhotoSize>) -> Option<ImageSource> {
    thumbnail.map(|photo| ImageSource::new(&photo.file.id, "image/jpeg"))
}

fn sticker_image_source(sticker: &Sticker) -> Option<ImageSource> {
    if sticker.flags.is_animated || sticker.flags.is_video {
        return thumbnail_source(sticker.thumbnail.as_ref());
    }
    Some(ImageSource::new(&sticker.file.id, "image/webp"))
}

fn preferred_photo(photos: &[PhotoSize], low_detail: bool) -> Option<&PhotoSize> {
    let area = |photo: &&PhotoSize| u64::from(photo.width) * u64::from(photo.height);
    let largest = photos.iter().max_by_key(area)?;
    if !low_detail {
        return Some(largest);
    }
    photos
        .iter()
        .filter(|photo| photo.width.max(photo.height) >= LOW_DETAIL_EDGE)
        .min_by_key(area)
        .or(Some(largest))
}

fn low_detail_enabled() -> bool {
    std::env::var("PLANABRAIN_CODEX_IMAGE_DETAIL")
        .map(|value| value.trim().eq_ignore_ascii_case("low"))
        .unwrap_or(false)
}

pub(crate) fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

pub(crate) fn skip_notice(skipped: &[ImageSkip]) -> Option<String> {
    let mut lines: Vec<&str> = Vec::new();
    for skip in skipped {
        let line = skip.notice();
        if !lines.contains(&line) {
            lines.push(line);
        }
    }
    (!lines.is_empty()).then(|| lines.join("\n"))
}

pub(crate) async fn load_turn_images<B>(
    bot: &B,
    sources: Vec<ImageSource>,
    allowed: bool,
) -> TurnImages
where
    B: Requester + teloxide::net::Download + ?Sized,
{
    if sources.is_empty() {
        return TurnImages::default();
    }
    if !allowed {
        return TurnImages {
            notice: Some(RATE_LIMITED_NOTICE.to_string()),
            ..TurnImages::default()
        };
    }
    let mut images = TurnImages::default();
    let mut skipped = Vec::new();
    for source in sources.into_iter().take(MAX_TURN_IMAGES) {
        match download_image(bot, &source).await {
            Ok(input) => {
                images.inputs.push(input);
                images.sources.push(source);
            }
            Err(skip) => skipped.push(skip),
        }
    }
    images.notice = skip_notice(&skipped);
    images
}

async fn download_image<B>(
    bot: &B,
    source: &ImageSource,
) -> Result<planabrain::ImageInput, ImageSkip>
where
    B: Requester + teloxide::net::Download + ?Sized,
{
    let file = bot
        .get_file(FileId(source.file_id.clone()))
        .await
        .map_err(|err| {
            warn!("이미지 파일 조회 실패: {}", err);
            ImageSkip::Failed
        })?;
    if u64::from(file.size) > MAX_IMAGE_BYTES {
        return Err(ImageSkip::TooLarge);
    }
    let dir = image_dir().ok_or(ImageSkip::Failed)?;
    fs::create_dir_all(&dir).await.map_err(|err| {
        warn!("이미지 임시 디렉터리 생성 실패: {}", err);
        ImageSkip::Failed
    })?;
    let path = dir.join(temp_file_name());
    let result = write_and_check(bot, &file.path, &path).await;
    if result.is_err() {
        let _ = fs::remove_file(&path).await;
    }
    result.map(|mime_type| planabrain::ImageInput {
        path,
        mime_type: mime_type.to_string(),
    })
}

async fn write_and_check<B>(bot: &B, remote: &str, path: &Path) -> Result<&'static str, ImageSkip>
where
    B: Requester + teloxide::net::Download + ?Sized,
{
    let mut output = fs::File::create(path).await.map_err(|err| {
        warn!("이미지 임시 파일 생성 실패: {}", err);
        ImageSkip::Failed
    })?;
    bot.download_file(remote, &mut output).await.map_err(|_| {
        warn!("이미지 다운로드 실패");
        ImageSkip::Failed
    })?;
    let bytes = fs::read(path).await.map_err(|err| {
        warn!("이미지 임시 파일 읽기 실패: {}", err);
        ImageSkip::Failed
    })?;
    if bytes.len() as u64 > MAX_IMAGE_BYTES {
        return Err(ImageSkip::TooLarge);
    }
    sniff_image_mime(&bytes).ok_or(ImageSkip::Unsupported)
}

fn image_dir() -> Option<PathBuf> {
    let current_dir = std::env::current_dir()
        .map_err(|err| warn!("현재 작업 디렉터리 조회 실패: {}", err))
        .ok()?;
    let data_root = std::env::var("PLANABRAIN_DATA_DIR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .map(|value| current_dir.join(value))
        .unwrap_or(current_dir);
    Some(data_root.join(".planabot/planabrain_images"))
}

fn temp_file_name() -> String {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let sequence = DOWNLOAD_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("image_{timestamp}_{sequence}.tmp")
}

#[derive(Debug)]
struct MediaGroupEntry {
    items: Vec<(i32, ImageSource)>,
    touched: Instant,
    claimed: bool,
}

#[derive(Debug, Default)]
pub(crate) struct MediaGroupCache {
    entries: HashMap<(i64, String), MediaGroupEntry>,
}

impl MediaGroupCache {
    pub(crate) fn record(
        &mut self,
        chat_id: i64,
        group_id: &str,
        message_id: i32,
        source: ImageSource,
    ) {
        self.prune(Instant::now());
        let entry = self.entry(chat_id, group_id);
        if !entry.items.iter().any(|(id, _)| *id == message_id) {
            entry.items.push((message_id, source));
            entry.items.sort_by_key(|(id, _)| *id);
        }
    }

    pub(crate) fn images(&self, chat_id: i64, group_id: &str) -> Vec<ImageSource> {
        self.entries
            .get(&(chat_id, group_id.to_string()))
            .map(|entry| {
                entry
                    .items
                    .iter()
                    .take(MAX_TURN_IMAGES)
                    .map(|(_, source)| source.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub(crate) fn claim(&mut self, chat_id: i64, group_id: &str) -> bool {
        self.prune(Instant::now());
        let entry = self.entry(chat_id, group_id);
        !std::mem::replace(&mut entry.claimed, true)
    }

    fn entry(&mut self, chat_id: i64, group_id: &str) -> &mut MediaGroupEntry {
        let entry = self
            .entries
            .entry((chat_id, group_id.to_string()))
            .or_insert_with(|| MediaGroupEntry {
                items: Vec::new(),
                touched: Instant::now(),
                claimed: false,
            });
        entry.touched = Instant::now();
        entry
    }

    fn prune(&mut self, now: Instant) {
        self.entries
            .retain(|_, entry| now.duration_since(entry.touched) < MEDIA_GROUP_TTL);
        while self.entries.len() >= MAX_MEDIA_GROUPS {
            let Some(oldest) = self
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.touched)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            self.entries.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ImageSkip, ImageSource, MAX_TURN_IMAGES, MediaGroupCache, extract_image_source,
        media_label, preferred_photo, skip_notice, sniff_image_mime, sticker_image_source,
    };
    use teloxide::types::{Message, PhotoSize, Sticker};

    fn sticker(is_animated: bool, is_video: bool, thumbnail: bool) -> Sticker {
        let mut value = serde_json::json!({
            "file_id": "sticker-file",
            "file_unique_id": "sticker-unique",
            "file_size": 1024,
            "width": 512,
            "height": 512,
            "type": "regular",
            "is_animated": is_animated,
            "is_video": is_video,
            "emoji": "\u{1F600}"
        });
        if thumbnail {
            value["thumbnail"] = photo_json("thumb-file", 128, 128);
        }
        serde_json::from_value(value).expect("sticker json")
    }

    fn photo_json(id: &str, width: u32, height: u32) -> serde_json::Value {
        serde_json::json!({
            "file_id": id,
            "file_unique_id": format!("{id}-unique"),
            "file_size": width * height / 10,
            "width": width,
            "height": height
        })
    }

    fn photos(sizes: &[(&str, u32, u32)]) -> Vec<PhotoSize> {
        sizes
            .iter()
            .map(|(id, width, height)| {
                serde_json::from_value(photo_json(id, *width, *height)).expect("photo json")
            })
            .collect()
    }

    fn message(extra: serde_json::Value) -> Message {
        let mut value = serde_json::json!({
            "message_id": 7,
            "date": 1_700_000_000,
            "chat": { "id": 42, "type": "private", "first_name": "tester" },
            "from": { "id": 42, "is_bot": false, "first_name": "tester" }
        });
        if let (Some(target), Some(fields)) = (value.as_object_mut(), extra.as_object()) {
            for (key, field) in fields {
                target.insert(key.clone(), field.clone());
            }
        }
        serde_json::from_value(value).expect("message json")
    }

    fn source(id: &str) -> ImageSource {
        ImageSource {
            file_id: id.to_string(),
            mime_type: "image/jpeg".to_string(),
        }
    }

    #[test]
    fn static_sticker_uses_its_own_file() {
        let source = sticker_image_source(&sticker(false, false, true)).expect("source");
        assert_eq!(source.file_id, "sticker-file");
        assert_eq!(source.mime_type, "image/webp");
    }

    #[test]
    fn animated_and_video_stickers_use_the_thumbnail() {
        for (animated, video) in [(true, false), (false, true)] {
            let source = sticker_image_source(&sticker(animated, video, true)).expect("source");
            assert_eq!(source.file_id, "thumb-file");
        }
        assert!(sticker_image_source(&sticker(true, false, false)).is_none());
    }

    #[test]
    fn low_detail_picks_the_smallest_photo_that_still_fills_512px() {
        let sizes = photos(&[
            ("s", 90, 67),
            ("m", 320, 240),
            ("l", 800, 600),
            ("x", 1280, 960),
        ]);
        assert_eq!(
            preferred_photo(&sizes, false).map(|p| p.file.id.0.as_str()),
            Some("x")
        );
        assert_eq!(
            preferred_photo(&sizes, true).map(|p| p.file.id.0.as_str()),
            Some("l")
        );
        let small = photos(&[("s", 90, 67), ("m", 320, 240)]);
        assert_eq!(
            preferred_photo(&small, true).map(|p| p.file.id.0.as_str()),
            Some("m")
        );
        assert!(preferred_photo(&[], true).is_none());
    }

    #[test]
    fn gif_video_and_video_note_thumbnails_become_images() {
        let thumb = photo_json("thumb", 320, 180);
        let animation = message(serde_json::json!({
            "animation": {
                "file_id": "anim", "file_unique_id": "anim-u", "file_size": 2048, "mime_type": "video/mp4", "width": 320, "height": 180,
                "duration": 2, "thumbnail": thumb.clone()
            },
            "document": { "file_id": "anim", "file_unique_id": "anim-u" }
        }));
        let video = message(serde_json::json!({
            "video": {
                "file_id": "vid", "file_unique_id": "vid-u", "file_size": 2048, "mime_type": "video/mp4", "width": 320, "height": 180,
                "duration": 5, "thumbnail": thumb.clone()
            }
        }));
        let note = message(serde_json::json!({
            "video_note": {
                "file_id": "note", "file_unique_id": "note-u", "file_size": 2048, "length": 240,
                "duration": 5, "thumbnail": thumb
            }
        }));
        for (msg, label) in [
            (animation, "(GIF)"),
            (video, "(영상)"),
            (note, "(영상 메시지)"),
        ] {
            assert_eq!(
                extract_image_source(&msg).map(|s| s.file_id),
                Some("thumb".to_string())
            );
            assert_eq!(media_label(&msg).as_deref(), Some(label));
        }
    }

    #[test]
    fn documents_count_only_when_they_are_images() {
        let image = message(serde_json::json!({
            "document": { "file_id": "doc", "file_unique_id": "doc-u", "mime_type": "image/heic" }
        }));
        let pdf = message(serde_json::json!({
            "document": {
                "file_id": "pdf", "file_unique_id": "pdf-u", "mime_type": "application/pdf",
                "thumbnail": photo_json("pdf-thumb", 90, 120)
            }
        }));
        let clip = message(serde_json::json!({
            "document": {
                "file_id": "clip", "file_unique_id": "clip-u", "mime_type": "video/mp4",
                "thumbnail": photo_json("clip-thumb", 320, 180)
            }
        }));
        assert_eq!(
            extract_image_source(&clip).map(|s| s.file_id),
            Some("clip-thumb".to_string())
        );
        assert_eq!(media_label(&clip).as_deref(), Some("(영상)"));
        assert_eq!(
            extract_image_source(&image).map(|s| s.mime_type),
            Some("image/heic".to_string())
        );
        assert_eq!(media_label(&image).as_deref(), Some("(이미지 파일)"));
        assert!(extract_image_source(&pdf).is_none());
        assert!(media_label(&pdf).is_none());
    }

    #[test]
    fn image_type_is_read_from_the_file_signature() {
        assert_eq!(
            sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0]),
            Some("image/jpeg")
        );
        assert_eq!(
            sniff_image_mime(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
            Some("image/png")
        );
        assert_eq!(sniff_image_mime(b"GIF89a...."), Some("image/gif"));
        assert_eq!(
            sniff_image_mime(b"RIFF\0\0\0\0WEBPVP8 "),
            Some("image/webp")
        );
        assert_eq!(sniff_image_mime(b"RIFF\0\0\0\0WAVE"), None);
        assert_eq!(sniff_image_mime(b"\0\0\0\x18ftypheic"), None);
        assert_eq!(sniff_image_mime(&[]), None);
    }

    #[test]
    fn skip_notices_are_deduplicated_in_order() {
        assert_eq!(skip_notice(&[]), None);
        let notice = skip_notice(&[
            ImageSkip::Unsupported,
            ImageSkip::TooLarge,
            ImageSkip::Unsupported,
        ])
        .expect("notice");
        assert_eq!(notice.lines().count(), 2);
        assert!(notice.starts_with("지원하지 않는 형식"));
    }

    #[test]
    fn media_groups_collect_in_message_order_and_are_claimed_once() {
        let mut cache = MediaGroupCache::default();
        cache.record(1, "album", 12, source("b"));
        cache.record(1, "album", 11, source("a"));
        cache.record(1, "album", 12, source("b"));
        cache.record(2, "album", 11, source("other-chat"));
        let ids: Vec<String> = cache
            .images(1, "album")
            .into_iter()
            .map(|s| s.file_id)
            .collect();
        assert_eq!(ids, ["a", "b"]);
        assert!(cache.claim(1, "album"));
        assert!(!cache.claim(1, "album"));
        assert!(cache.claim(2, "album"));
        for id in 0..10 {
            cache.record(3, "big", id, source(&format!("p{id}")));
        }
        assert_eq!(cache.images(3, "big").len(), MAX_TURN_IMAGES);
        assert!(cache.images(9, "missing").is_empty());
    }
}
