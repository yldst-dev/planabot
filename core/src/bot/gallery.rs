use log::warn;
use once_cell::sync::Lazy;
use reqwest::Url;
use teloxide::types::{
    ChatKind, InlineKeyboardButton, InlineKeyboardMarkup, Message, PublicChatKind,
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

pub(crate) fn extract_gallery_id(
    text: &str,
    msg: &Message,
    bot_username: &str,
) -> Option<GalleryIdMatch> {
    static BANG_RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"^!(\d+)$").unwrap());
    static HITOMI_READER_RE: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/(?:reader|galleries)/(\d+)").unwrap()
    });
    static HITOMI_SLUG_RE: Lazy<regex::Regex> = Lazy::new(|| {
        regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/[^\s#]*(\d+)\.html").unwrap()
    });
    static K_HENTAI_URL_RE: Lazy<regex::Regex> =
        Lazy::new(|| regex::Regex::new(r"(?:https?://)?(?:www\.)?k-hentai\.org/r/(\d+)").unwrap());

    if let Some(id) =
        extract_gallery_id_from_url(text, &HITOMI_READER_RE, &HITOMI_SLUG_RE, &K_HENTAI_URL_RE)
    {
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

                let pattern = format!(r"^@{}\s+(\d+)", regex::escape(bot_username));
                if let Some(gallery_id) = regex::Regex::new(&pattern)
                    .ok()
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

fn extract_gallery_id_from_url(
    text: &str,
    hitomi_reader_re: &regex::Regex,
    hitomi_slug_re: &regex::Regex,
    k_hentai_re: &regex::Regex,
) -> Option<String> {
    if let Some(cap) = hitomi_reader_re.captures(text) {
        return Some(cap[1].to_string());
    }

    if let Some(cap) = hitomi_slug_re.captures(text) {
        return Some(cap[1].to_string());
    }

    if let Some(cap) = k_hentai_re.captures(text) {
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
    let title = html::escape(&info.title);
    let artists = html::escape(&info.artists);
    let language = html::escape(&info.language);
    let tags = if info.tags.is_empty() {
        "태그 없음".to_string()
    } else {
        info.tags
            .iter()
            .map(|t| html::escape(t))
            .collect::<Vec<_>>()
            .join(", ")
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

pub(crate) fn build_gallery_keyboard(
    info: &GalleryInfo,
    include_save: bool,
) -> InlineKeyboardMarkup {
    let mut rows = Vec::new();

    match Url::parse(&info.hitomi_url()) {
        Ok(hitomi) => rows.push(vec![InlineKeyboardButton::url("Hitomi.la 열기", hitomi)]),
        Err(err) => warn!("hitomi URL 파싱 실패 (id {}): {}", info.id, err),
    }

    match Url::parse(&info.k_hentai_url()) {
        Ok(k_hentai) => rows.push(vec![InlineKeyboardButton::url("K-Hentai 열기", k_hentai)]),
        Err(err) => warn!("k-hentai URL 파싱 실패 (id {}): {}", info.id, err),
    }

    if include_save {
        rows.push(vec![InlineKeyboardButton::callback(
            "개인 메시지로 저장",
            format!("save_{}", info.id),
        )]);
    }

    InlineKeyboardMarkup::new(rows)
}

pub(crate) fn is_private_chat(msg: &Message) -> bool {
    matches!(msg.chat.kind, ChatKind::Private(_))
}

#[cfg(test)]
mod tests {
    use super::extract_gallery_id_from_url;

    #[test]
    fn extracts_hitomi_gallery_id_from_url() {
        let text = "https://hitomi.la/reader/3723891.html#1";
        let id = extract_gallery_id_from_url(
            text,
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/(?:reader|galleries)/(\d+)")
                .unwrap(),
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/[^\s#]*(\d+)\.html").unwrap(),
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?k-hentai\.org/r/(\d+)").unwrap(),
        );
        assert_eq!(id.as_deref(), Some("3723891"));
    }

    #[test]
    fn extracts_k_hentai_gallery_id_from_url() {
        let text = "https://k-hentai.org/r/3723891#1";
        let id = extract_gallery_id_from_url(
            text,
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/(?:reader|galleries)/(\d+)")
                .unwrap(),
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/[^\s#]*(\d+)\.html").unwrap(),
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?k-hentai\.org/r/(\d+)").unwrap(),
        );
        assert_eq!(id.as_deref(), Some("3723891"));
    }

    #[test]
    fn extracts_k_hentai_gallery_id_without_scheme() {
        let text = "k-hentai.org/r/3723891";
        let id = extract_gallery_id_from_url(
            text,
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/(?:reader|galleries)/(\d+)")
                .unwrap(),
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?hitomi\.la/[^\s#]*(\d+)\.html").unwrap(),
            &regex::Regex::new(r"(?:https?://)?(?:www\.)?k-hentai\.org/r/(\d+)").unwrap(),
        );
        assert_eq!(id.as_deref(), Some("3723891"));
    }
}
