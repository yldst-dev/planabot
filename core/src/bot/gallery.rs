use std::sync::LazyLock;

use log::warn;
use reqwest::Url;
use teloxide::types::{
    ChatKind, InlineKeyboardButton, InlineKeyboardButtonKind, InlineKeyboardMarkup, Message,
    PublicChatKind,
};
use teloxide::utils::html;

use crate::hitomi::GalleryInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum GalleryIdSource {
    Direct,
    Url,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct GalleryIdMatch {
    pub(crate) id: String,
    pub(crate) source: GalleryIdSource,
}

const TITLE_LIMIT: usize = 300;
const ARTISTS_LIMIT: usize = 200;
const LANGUAGE_LIMIT: usize = 50;
const TAGS_LIMIT: usize = 2000;

static HITOMI_READER_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/(?:reader|galleries)/(\d+)").unwrap()
});
static HITOMI_SLUG_RE: LazyLock<regex::Regex> = LazyLock::new(|| {
    regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/[^\s#]*?(\d+)\.html").unwrap()
});
static K_HENTAI_URL_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"(?:https?://)?(?:www\.)?k-hentai\.org/r/(\d+)").unwrap());

pub(crate) fn extract_gallery_id(
    text: &str,
    msg: &Message,
    bot_username: &str,
) -> Option<GalleryIdMatch> {
    match_gallery_id(text, msg, bot_username).filter(|found| is_gallery_id(&found.id))
}

fn match_gallery_id(text: &str, msg: &Message, bot_username: &str) -> Option<GalleryIdMatch> {
    static BANG_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r"^!(\d+)$").unwrap());
    if let Some(id) = extract_gallery_id_from_url(text) {
        return Some(GalleryIdMatch {
            id,
            source: GalleryIdSource::Url,
        });
    }

    if let Some(cap) = BANG_RE.captures(text) {
        return Some(GalleryIdMatch {
            id: cap[1].to_string(),
            source: GalleryIdSource::Direct,
        });
    }

    match &msg.chat.kind {
        ChatKind::Private(_) => {
            if text.chars().all(|c| c.is_ascii_digit()) {
                return Some(GalleryIdMatch {
                    id: text.to_string(),
                    source: GalleryIdSource::Direct,
                });
            }
        }
        ChatKind::Public(public) => match &public.kind {
            PublicChatKind::Group | PublicChatKind::Supergroup(_) => {
                if bot_username.is_empty() {
                    return None;
                }

                let mentions_bot = text
                    .strip_prefix('@')
                    .is_some_and(|rest| rest.starts_with(bot_username));
                let pattern = format!(r"^@{}\s+(\d+)", regex::escape(bot_username));
                if let Some(gallery_id) = mentions_bot
                    .then(|| regex::Regex::new(&pattern).ok())
                    .flatten()
                    .and_then(|re| re.captures(text).map(|cap| cap[1].to_string()))
                {
                    return Some(GalleryIdMatch {
                        id: gallery_id,
                        source: GalleryIdSource::Direct,
                    });
                }
            }
            _ => {}
        },
    }

    None
}

pub(crate) fn extract_gallery_id_from_url(text: &str) -> Option<String> {
    if let Some(cap) = HITOMI_READER_RE.captures(text) {
        return Some(cap[1].to_string());
    }

    if let Some(cap) = HITOMI_SLUG_RE.captures(text) {
        return Some(cap[1].to_string());
    }

    if let Some(cap) = K_HENTAI_URL_RE.captures(text) {
        return Some(cap[1].to_string());
    }

    None
}

pub(crate) fn render_gallery_message(info: &GalleryInfo, saved: bool) -> String {
    render_gallery_message_with_user(info, saved, None)
}

pub(crate) fn render_gallery_message_for_user(
    info: &GalleryInfo,
    saved: bool,
    display_name: &str,
) -> String {
    let masked = mask_display_name(display_name);
    render_gallery_message_with_user(info, saved, Some(&masked))
}

fn render_gallery_message_with_user(
    info: &GalleryInfo,
    saved: bool,
    masked_user: Option<&str>,
) -> String {
    let title = html::escape(&clip(&info.title, TITLE_LIMIT));
    let artists = html::escape(&clip(&info.artists, ARTISTS_LIMIT));
    let language = html::escape(&clip(&info.language, LANGUAGE_LIMIT));
    let tags = if info.tags.is_empty() {
        "태그 없음".to_string()
    } else {
        html::escape(&clip(&info.tags.join(", "), TAGS_LIMIT))
    };

    let saved_suffix = if saved { " (#저장됨)" } else { "" };
    let header = match masked_user {
        Some(user) => format!(
            "<b>분석 완료.</b>\n{} 선생님.\nID {} 결과입니다.{}",
            html::escape(user),
            info.id,
            saved_suffix
        ),
        None => format!(
            "<b>분석 완료.</b>\n선생님.\nID {} 결과입니다.{}",
            info.id, saved_suffix
        ),
    };

    format!(
        "{header}\n\n<b>제목:</b> {title}\n<b>작가:</b> {artists}\n<b>언어:</b> {language}\n<b>태그:</b> {tags}"
    )
}

fn clip(text: &str, limit: usize) -> String {
    if text.encode_utf16().count() <= limit {
        return text.to_string();
    }
    let mut used = 1;
    let mut clipped: String = text
        .chars()
        .take_while(|c| {
            used += c.len_utf16();
            used <= limit
        })
        .collect();
    clipped.push('…');
    clipped
}

fn mask_display_name(name: &str) -> String {
    let chars: Vec<char> = name.chars().collect();
    match chars.len() {
        0 => String::new(),
        1 => "*".to_string(),
        2 => format!("{}*", chars[0]),
        _ => {
            let mut masked = String::new();
            masked.push(chars[0]);
            masked.extend(std::iter::repeat_n('*', chars.len() - 2));
            masked.push(chars[chars.len() - 1]);
            masked
        }
    }
}

fn gallery_link_rows(info: &GalleryInfo) -> Vec<Vec<InlineKeyboardButton>> {
    let mut rows = Vec::new();

    match Url::parse(&info.hitomi_url()) {
        Ok(hitomi) => rows.push(vec![InlineKeyboardButton::url("Hitomi.la 열기", hitomi)]),
        Err(err) => warn!("hitomi URL 파싱 실패 (id {}): {}", info.id, err),
    }

    match Url::parse(&info.k_hentai_url()) {
        Ok(k_hentai) => rows.push(vec![InlineKeyboardButton::url("K-Hentai 열기", k_hentai)]),
        Err(err) => warn!("k-hentai URL 파싱 실패 (id {}): {}", info.id, err),
    }

    rows
}

fn with_save_row(
    mut rows: Vec<Vec<InlineKeyboardButton>>,
    info: &GalleryInfo,
    include_save: bool,
) -> InlineKeyboardMarkup {
    if include_save {
        rows.push(vec![InlineKeyboardButton::callback(
            "개인 메시지로 저장",
            format!("save_{}", info.id),
        )]);
    }
    InlineKeyboardMarkup::new(rows)
}

pub(crate) fn is_gallery_id(gallery_id: &str) -> bool {
    (1..=12).contains(&gallery_id.len()) && gallery_id.bytes().all(|byte| byte.is_ascii_digit())
}

pub(crate) fn fetch_action_button(gallery_id: &str) -> InlineKeyboardButton {
    InlineKeyboardButton::callback("받기", format!("fetch_{gallery_id}"))
}

pub(crate) fn preparing_action_button(gallery_id: &str) -> InlineKeyboardButton {
    InlineKeyboardButton::callback("준비 중", format!("prep_{gallery_id}"))
}

pub(crate) fn download_action_button(token: &str) -> InlineKeyboardButton {
    InlineKeyboardButton::callback("다운로드", format!("dl_{token}"))
}

fn is_gallery_action_callback(data: &str) -> bool {
    data.starts_with("fetch_") || data.starts_with("prep_") || data.starts_with("dl_")
}

pub(crate) fn replace_gallery_action_button(
    markup: &InlineKeyboardMarkup,
    button: InlineKeyboardButton,
) -> InlineKeyboardMarkup {
    let mut replaced = false;
    let mut rows = Vec::new();
    for row in &markup.inline_keyboard {
        let mut next_row = Vec::new();
        for btn in row {
            match &btn.kind {
                InlineKeyboardButtonKind::CallbackData(data)
                    if is_gallery_action_callback(data) =>
                {
                    next_row.push(button.clone());
                    replaced = true;
                }
                _ => next_row.push(btn.clone()),
            }
        }
        rows.push(next_row);
    }
    if !replaced {
        let save_idx = rows.iter().position(|row| {
            row.iter().any(|btn| {
                matches!(
                    &btn.kind,
                    InlineKeyboardButtonKind::CallbackData(data) if data.starts_with("save_")
                )
            })
        });
        match save_idx {
            Some(idx) => rows.insert(idx, vec![button]),
            None => rows.push(vec![button]),
        }
    }
    InlineKeyboardMarkup::new(rows)
}

pub(crate) fn build_gallery_keyboard(
    info: &GalleryInfo,
    include_save: bool,
) -> InlineKeyboardMarkup {
    let mut rows = gallery_link_rows(info);
    rows.push(vec![fetch_action_button(&info.id)]);
    with_save_row(rows, info, include_save)
}

pub(crate) fn build_gallery_preparing_keyboard(
    info: &GalleryInfo,
    include_save: bool,
) -> InlineKeyboardMarkup {
    let mut rows = gallery_link_rows(info);
    rows.push(vec![preparing_action_button(&info.id)]);
    with_save_row(rows, info, include_save)
}

pub(crate) fn build_share_ready_keyboard(
    info: &GalleryInfo,
    token: &str,
    include_save: bool,
) -> InlineKeyboardMarkup {
    let mut rows = gallery_link_rows(info);
    rows.push(vec![download_action_button(token)]);
    with_save_row(rows, info, include_save)
}

pub(crate) fn is_private_chat(msg: &Message) -> bool {
    matches!(msg.chat.kind, ChatKind::Private(_))
}

#[cfg(test)]
pub(crate) fn telegram_text_len(rendered: &str) -> usize {
    let text = rendered.replace("<b>", "").replace("</b>", "");
    assert!(!text.contains(['<', '>']), "unescaped markup in {text}");
    for (at, _) in text.match_indices('&') {
        assert!(
            ["&amp;", "&lt;", "&gt;"]
                .iter()
                .any(|entity| text[at..].starts_with(entity)),
            "broken entity at {at}"
        );
    }
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
        .encode_utf16()
        .count()
}

#[cfg(test)]
mod tests {
    use super::{extract_gallery_id, extract_gallery_id_from_url, telegram_text_len};
    use crate::hitomi::GalleryInfo;

    #[test]
    fn ready_keyboard_uses_download_callback() {
        let info = crate::hitomi::GalleryInfo {
            id: "123".to_string(),
            title: "t".to_string(),
            artists: "a".to_string(),
            language: "korean".to_string(),
            tags: vec![],
        };
        let markup = super::build_share_ready_keyboard(&info, "tok", true);
        let data = callback_data(&markup);
        assert!(data.iter().any(|d| d == "dl_tok"));
        assert!(data.iter().any(|d| d == "save_123"));
        assert!(!data.iter().any(|d| d.starts_with("fetch_")));
        assert_eq!(
            url_labels(&markup),
            vec!["Hitomi.la 열기".to_string(), "K-Hentai 열기".to_string()]
        );
    }

    #[test]
    fn gallery_keyboard_includes_fetch() {
        let info = crate::hitomi::GalleryInfo {
            id: "123".to_string(),
            title: "t".to_string(),
            artists: "a".to_string(),
            language: "korean".to_string(),
            tags: vec![],
        };
        let markup = super::build_gallery_keyboard(&info, false);
        let data = callback_data(&markup);
        assert_eq!(data, vec!["fetch_123".to_string()]);
        assert_eq!(
            url_labels(&markup),
            vec!["Hitomi.la 열기".to_string(), "K-Hentai 열기".to_string()]
        );
    }

    #[test]
    fn preparing_keyboard_keeps_link_buttons() {
        let info = crate::hitomi::GalleryInfo {
            id: "123".to_string(),
            title: "t".to_string(),
            artists: "a".to_string(),
            language: "korean".to_string(),
            tags: vec![],
        };
        let markup = super::build_gallery_preparing_keyboard(&info, true);
        let data = callback_data(&markup);
        assert_eq!(data, vec!["prep_123".to_string(), "save_123".to_string()]);
        assert_eq!(
            url_labels(&markup),
            vec!["Hitomi.la 열기".to_string(), "K-Hentai 열기".to_string()]
        );
    }

    #[test]
    fn replace_action_keeps_url_and_save_buttons() {
        let info = crate::hitomi::GalleryInfo {
            id: "123".to_string(),
            title: "t".to_string(),
            artists: "a".to_string(),
            language: "korean".to_string(),
            tags: vec![],
        };
        let original = super::build_gallery_keyboard(&info, true);
        let preparing =
            super::replace_gallery_action_button(&original, super::preparing_action_button("123"));
        assert_eq!(
            callback_data(&preparing),
            vec!["prep_123".to_string(), "save_123".to_string()]
        );
        assert_eq!(
            url_labels(&preparing),
            vec!["Hitomi.la 열기".to_string(), "K-Hentai 열기".to_string()]
        );
        let ready =
            super::replace_gallery_action_button(&preparing, super::download_action_button("tok"));
        assert_eq!(
            callback_data(&ready),
            vec!["dl_tok".to_string(), "save_123".to_string()]
        );
        assert_eq!(
            url_labels(&ready),
            vec!["Hitomi.la 열기".to_string(), "K-Hentai 열기".to_string()]
        );
    }

    fn callback_data(markup: &teloxide::types::InlineKeyboardMarkup) -> Vec<String> {
        markup
            .inline_keyboard
            .iter()
            .flatten()
            .filter_map(|btn| match &btn.kind {
                teloxide::types::InlineKeyboardButtonKind::CallbackData(data) => Some(data.clone()),
                _ => None,
            })
            .collect()
    }

    fn url_labels(markup: &teloxide::types::InlineKeyboardMarkup) -> Vec<String> {
        markup
            .inline_keyboard
            .iter()
            .flatten()
            .filter_map(|btn| match &btn.kind {
                teloxide::types::InlineKeyboardButtonKind::Url(_) => Some(btn.text.clone()),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn extracts_hitomi_gallery_id_from_url() {
        let text = "https://hitomi.la/reader/3723891.html#1";
        let id = extract_gallery_id_from_url(text);
        assert_eq!(id.as_deref(), Some("3723891"));
    }

    #[test]
    fn gallery_ids_must_be_short_digit_strings() {
        assert!(super::is_gallery_id("3723891"));
        assert!(!super::is_gallery_id(""));
        assert!(!super::is_gallery_id("12a4"));
        assert!(!super::is_gallery_id("1234567890123"));
        assert!(!super::is_gallery_id("--help"));
    }

    #[test]
    fn title_style_hitomi_urls_keep_the_whole_gallery_id() {
        for (text, expected) in [
            (
                "https://hitomi.la/doujinshi/some-title-korean-1234567.html",
                "1234567",
            ),
            (
                "https://hitomi.la/manga/%ED%95%9C%EA%B5%AD%EC%96%B4-3723891.html#1",
                "3723891",
            ),
            (
                "https://hitomi.la/doujinshi/title-2024-1234567.html",
                "1234567",
            ),
        ] {
            assert_eq!(extract_gallery_id_from_url(text).as_deref(), Some(expected));
        }
    }

    #[test]
    fn extracts_k_hentai_gallery_id_from_url() {
        let text = "https://k-hentai.org/r/3723891#1";
        let id = extract_gallery_id_from_url(text);
        assert_eq!(id.as_deref(), Some("3723891"));
    }

    fn message(chat: serde_json::Value, text: &str) -> teloxide::types::Message {
        serde_json::from_value(serde_json::json!({
            "message_id": 1, "date": 0, "text": text, "chat": chat,
            "from": {"id": 42, "is_bot": false, "first_name": "A"}
        }))
        .unwrap()
    }

    #[test]
    fn every_lookup_path_applies_the_gallery_id_rule() {
        let private = serde_json::json!({"id": 7, "first_name": "A", "type": "private"});
        let group = serde_json::json!({"id": -100, "title": "g", "type": "supergroup"});
        let longest = "9".repeat(12);
        let too_long = "9".repeat(13);
        for (chat, text, expected) in [
            (&private, "3723891".to_string(), Some("3723891".to_string())),
            (&private, longest.clone(), Some(longest.clone())),
            (&private, too_long.clone(), None),
            (&private, format!("!{too_long}"), None),
            (&private, "!٣٢١".to_string(), None),
            (
                &private,
                format!("https://hitomi.la/reader/{too_long}.html"),
                None,
            ),
            (&private, format!("k-hentai.org/r/{too_long}"), None),
            (&group, format!("@bot {longest}"), Some(longest.clone())),
            (&group, format!("@bot {too_long}"), None),
            (
                &group,
                "@bot 3723891".to_string(),
                Some("3723891".to_string()),
            ),
        ] {
            let found = extract_gallery_id(&text, &message(chat.clone(), &text), "bot");
            assert_eq!(found.map(|found| found.id), expected, "{text}");
        }
    }

    fn overlong_info() -> GalleryInfo {
        GalleryInfo {
            id: "123".to_string(),
            title: "&<>𝒜가".repeat(4000),
            artists: "&<>작가, ".repeat(4000),
            language: "&<>".repeat(4000),
            tags: (0..4000).map(|n| format!("female:&<>{n}𝒜")).collect(),
        }
    }

    #[test]
    fn over_long_results_fit_telegram_without_broken_markup() {
        let info = overlong_info();
        for rendered in [
            super::render_gallery_message(&info, true),
            super::render_gallery_message_for_user(&info, true, &"가".repeat(64)),
        ] {
            assert!(telegram_text_len(&rendered) <= 4096);
            assert!(rendered.contains("<b>제목:</b> &amp;&lt;&gt;𝒜가"));
            assert!(rendered.contains('…'));
        }
    }

    #[test]
    fn short_results_are_rendered_whole() {
        let info = GalleryInfo {
            id: "123".to_string(),
            title: "제목 & 부제".to_string(),
            artists: "작가".to_string(),
            language: "한국어".to_string(),
            tags: vec!["a".to_string(), "b".to_string()],
        };
        let rendered = super::render_gallery_message(&info, false);
        assert!(rendered.ends_with(
            "<b>제목:</b> 제목 &amp; 부제\n<b>작가:</b> 작가\n<b>언어:</b> 한국어\n<b>태그:</b> a, b"
        ));
        assert!(!rendered.contains('…'));
    }

    #[test]
    fn clip_counts_utf16_units_and_never_splits_a_character() {
        assert_eq!(super::clip("가나다라", 3), "가나…");
        assert_eq!(super::clip("𝒜𝒜𝒜", 4), "𝒜…");
        assert_eq!(super::clip("가나다", 3), "가나다");
    }

    #[test]
    fn extracts_k_hentai_gallery_id_without_scheme() {
        let text = "k-hentai.org/r/3723891";
        let id = extract_gallery_id_from_url(text);
        assert_eq!(id.as_deref(), Some("3723891"));
    }
}
