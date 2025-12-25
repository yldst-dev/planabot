use once_cell::sync::Lazy;
use reqwest::Url;
use teloxide::types::{ChatKind, InlineKeyboardButton, InlineKeyboardMarkup, Message, PublicChatKind};
use teloxide::utils::html;

use crate::hitomi::GalleryInfo;

pub(crate) fn extract_gallery_id(text: &str, msg: &Message, bot_username: &str) -> Option<String> {
    static BANG_RE: Lazy<regex::Regex> = Lazy::new(|| regex::Regex::new(r"^!(\d+)$").unwrap());

    if let Some(cap) = BANG_RE.captures(text) {
        return Some(cap[1].to_string());
    }

    match &msg.chat.kind {
        ChatKind::Private(_) => {
            if text.chars().all(|c| c.is_ascii_digit()) {
                return Some(text.to_string());
            }
        }
        ChatKind::Public(public) => match &public.kind {
            PublicChatKind::Group | PublicChatKind::Supergroup(_) => {
                if bot_username.is_empty() {
                    return None;
                }

                let pattern = format!(r"^@{}\s+(\d+)", regex::escape(bot_username));
                if let Ok(re) = regex::Regex::new(&pattern) {
                    if let Some(cap) = re.captures(text) {
                        return Some(cap[1].to_string());
                    }
                }
            }
            _ => {}
        },
    }

    None
}

pub(crate) fn render_gallery_message(info: &GalleryInfo, saved: bool) -> String {
    let title = html::escape(&info.title);
    let artists = html::escape(&info.artists);
    let language = html::escape(&info.language);
    let tags = if info.tags.is_empty() {
        "태그 정보 없음".to_string()
    } else {
        info.tags
            .iter()
            .map(|t| html::escape(t))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let header = if saved {
        format!(
            "<b>선생님, ID {}에 대한 분석 결과입니다. (#저장됨)</b>",
            info.id
        )
    } else {
        format!("<b>선생님, ID {}에 대한 분석 결과입니다.</b>", info.id)
    };

    format!(
        "{header}\n\n<b>제목:</b> {title}\n<b>작가:</b> {artists}\n<b>언어:</b> {language}\n<b>태그:</b> {tags}"
    )
}

pub(crate) fn build_gallery_keyboard(
    info: &GalleryInfo,
    include_save: bool,
) -> InlineKeyboardMarkup {
    let hitomi = Url::parse(&info.hitomi_url()).expect("hitomi url should be valid");
    let k_hentai = Url::parse(&info.k_hentai_url()).expect("k-hentai url should be valid");

    let mut rows = vec![
        vec![InlineKeyboardButton::url("Hitomi.la에서 보기", hitomi)],
        vec![InlineKeyboardButton::url("K-Hentai에서 보기", k_hentai)],
    ];

    if include_save {
        rows.push(vec![InlineKeyboardButton::callback(
            "저장: 제 개인 메시지로 보내기",
            format!("save_{}", info.id),
        )]);
    }

    InlineKeyboardMarkup::new(rows)
}

pub(crate) fn is_private_chat(msg: &Message) -> bool {
    matches!(msg.chat.kind, ChatKind::Private(_))
}
