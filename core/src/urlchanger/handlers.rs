use crate::bot::{AppState, HandlerResult, extract_gallery_id_from_url};
use crate::urlchanger::delivery::{LinkPlan, LinkReply, deliver_link_plan};
use crate::urlchanger::google_share::resolve_google_share_link;
use crate::urlchanger::instagram::{InstagramMedia, InstagramMediaKind, fetch_instagram_media};
use crate::urlchanger::link_utils::{
    LinkConversion, MusicLink, MusicPlatform, contains_google_share_link, contains_instagram_link,
    contains_threads_link, contains_x_link, convert_instagram_links, convert_threads_links,
    convert_x_links, extract_google_share_links, extract_music_links, is_youtube_short_link,
};
use crate::urlchanger::music_card::build_music_card;
use crate::urlchanger::music_metadata::{MusicMetadata, download_cover, fetch_music_metadata};
use chrono::Utc;
use log::{error, warn};
use std::time::Duration;
use teloxide::dispatching::DpHandlerDescription;
use teloxide::prelude::*;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup, InputFile, ParseMode};
use teloxide::utils::html;
use tokio::time::timeout;

const CAPTION_LIMIT: usize = 1024;
const MUSIC_CARD_FILE_NAME: &str = "music_card.png";
const YOUTUBE_THUMBNAIL_FILE_NAME: &str = "youtube.jpg";
const YOUTUBE_PREVIEW_TIMEOUT: Duration = Duration::from_secs(8);
const MAX_GOOGLE_SHARE_LINKS: usize = 5;
const MAX_INSTAGRAM_PREVIEWS: usize = 3;

fn is_recent_message(msg: &Message, seconds: i64) -> bool {
    let now = Utc::now().timestamp();
    let msg_time = msg.date.timestamp();
    now - msg_time <= seconds
}

pub fn url_handlers<B>() -> Handler<'static, HandlerResult, DpHandlerDescription>
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetUpdates: Send,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    Update::filter_message().branch(
        dptree::filter(|msg: Message, state: AppState| {
            state.is_after_boot(&msg) && is_recent_message(&msg, 30)
        })
        .branch(
            dptree::filter(|msg: Message| msg.text().is_some_and(music_links_need_reply))
                .endpoint(handle_music_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_x_link(msg.text().unwrap())
            })
            .endpoint(handle_x_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_instagram_link(msg.text().unwrap())
            })
            .endpoint(handle_instagram_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_threads_link(msg.text().unwrap())
            })
            .endpoint(handle_threads_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_google_share_link(msg.text().unwrap())
            })
            .endpoint(handle_google_share_links::<B>),
        ),
    )
}

async fn is_privileged<B>(bot: &B, msg: &Message, state: &AppState, label: &str) -> bool
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
{
    match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member.kind.can_delete_messages(),
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생({}): {:?}", label, e);
            false
        }
    }
}

pub async fn handle_music_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = extract_music_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let any_tracking = links.iter().any(|link| link.had_tracking);
    let username = display_name(&msg);
    let plan = if is_youtube_only(&links) {
        let preview = load_youtube_preview(&links[0]).await;
        match youtube_plan(&username, text, &links, any_tracking, preview) {
            Some(plan) => plan,
            None => return Ok(()),
        }
    } else {
        let card = build_music_card(&links).await;
        music_plan(&username, text, &links, card)
    };

    let privileged = is_privileged(&bot, &msg, &state, "음악").await;
    deliver_link_plan(&bot, &msg, privileged, "음악", plan).await
}

fn music_plan(
    username: &str,
    original_text: &str,
    links: &[MusicLink],
    card: Option<Vec<u8>>,
) -> LinkPlan {
    let cleaned = build_cleaned_message_text(original_text, links);
    let message = format!("정리 완료.\n선생님.\n{username}: {cleaned}");
    let reply_text = build_cleaned_links_text(links);
    let caption = music_card_caption(username);
    let admin_caption = format!("{caption} {cleaned}");
    let markup = build_links_keyboard(links);

    let card = card.map(music_card_file);
    let admin = match card.clone().filter(|_| fits_caption(&admin_caption)) {
        Some(file) => LinkReply::photo(file, admin_caption).with_text_fallback(message),
        None => LinkReply::text(message),
    };
    let card = card.filter(|_| fits_caption(&caption));
    let reply = match card {
        Some(file) => LinkReply::photo(file, caption).with_text_fallback(reply_text),
        None => LinkReply::text(reply_text),
    };

    LinkPlan {
        admin: vec![admin.with_markup(markup.clone())],
        reply: vec![reply.with_markup(markup)],
    }
}

fn youtube_plan(
    username: &str,
    original_text: &str,
    links: &[MusicLink],
    had_tracking: bool,
    preview: Option<(MusicMetadata, Vec<u8>)>,
) -> Option<LinkPlan> {
    let cleaned_text = youtube_cleaned_text(links);
    let reposted = build_cleaned_message_text(original_text, links);
    let expanded = links
        .iter()
        .any(|link| is_youtube_short_link(&link.original));
    let status = if expanded || had_tracking {
        "정리 완료."
    } else {
        "확인 완료."
    };
    let message = if reposted.contains('\n') {
        format!("{status}\n선생님.\n{}:\n{}", username, reposted)
    } else {
        format!("{status}\n선생님.\n{}: {}", username, reposted)
    };
    let reply_text = match (expanded, had_tracking) {
        (true, _) => {
            format!("정리 완료.\n선생님.\n영상 주소를 기본 형식으로 바꿨습니다.\n{cleaned_text}")
        }
        (false, true) => {
            "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n확인 바랍니다.".to_string()
        }
        (false, false) => {
            "확인 완료.\n선생님.\n유튜브 링크입니다.\n원본 링크 버튼을 제공합니다.".to_string()
        }
    };
    let caption = |text: &str| -> Option<String> {
        let (metadata, _) = preview.as_ref()?;
        let caption = match &metadata.artist {
            Some(channel) => format!("{text}\n\n{}\n{channel}", metadata.title),
            None => format!("{text}\n\n{}", metadata.title),
        };
        fits_caption(&caption).then_some(caption)
    };
    let admin_caption = caption(&message);
    if admin_caption.is_none() && !expanded && !had_tracking {
        return None;
    }
    let reply_caption = caption(&reply_text);
    let post = |text: String, caption: Option<String>| match (caption, &preview) {
        (Some(caption), Some((_, thumbnail))) => LinkReply::photo(
            InputFile::memory(thumbnail.clone()).file_name(YOUTUBE_THUMBNAIL_FILE_NAME),
            caption,
        )
        .with_text_fallback(text),
        _ => LinkReply::text(text),
    };
    let markup = build_links_keyboard(links);

    Some(LinkPlan {
        admin: vec![post(message, admin_caption).with_markup(markup.clone())],
        reply: vec![post(reply_text, reply_caption).with_markup(markup)],
    })
}

async fn load_youtube_preview(link: &MusicLink) -> Option<(MusicMetadata, Vec<u8>)> {
    let load = async {
        let metadata = fetch_music_metadata(link).await?;
        let thumbnail = download_cover(&metadata.cover_url).await?;
        anyhow::Ok((metadata, thumbnail))
    };
    match timeout(YOUTUBE_PREVIEW_TIMEOUT, load).await {
        Ok(Ok(preview)) => Some(preview),
        Ok(Err(e)) => {
            warn!("유튜브 미리보기 수집 실패({}): {:#}", link.cleaned, e);
            None
        }
        Err(_) => {
            warn!("유튜브 미리보기 수집 시간 초과: {}", link.cleaned);
            None
        }
    }
}

pub async fn handle_x_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_x_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let privileged = is_privileged(&bot, &msg, &state, "X").await;
    let plan = x_plan(&display_name(&msg), text, &links);
    deliver_link_plan(&bot, &msg, privileged, "X", plan).await
}

fn x_plan(username: &str, original_text: &str, links: &[LinkConversion]) -> LinkPlan {
    let converted_text = replace_converted_links(original_text, links);
    let disable_preview = links.iter().any(|l| l.disable_preview);
    let markup = build_social_keyboard(links);

    LinkPlan {
        admin: vec![
            LinkReply::text(format!(
                "정리 완료.\n선생님.\n{}: {}",
                username, converted_text
            ))
            .with_markup(markup.clone())
            .with_disable_preview(disable_preview),
        ],
        reply: vec![
            LinkReply::text(format!(
                "정리 완료.\n선생님.\n임베드 링크입니다.\n{}",
                converted_text
            ))
            .with_markup(markup)
            .with_disable_preview(disable_preview),
        ],
    }
}

pub async fn handle_instagram_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_instagram_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let previews = load_instagram_previews(&links).await;
    let privileged = is_privileged(&bot, &msg, &state, "Instagram").await;
    let plan = instagram_plan(&display_name(&msg), text, &links, previews);
    deliver_link_plan(&bot, &msg, privileged, "Instagram", plan).await
}

fn instagram_plan(
    username: &str,
    original_text: &str,
    links: &[LinkConversion],
    previews: Vec<(LinkConversion, InstagramMedia)>,
) -> LinkPlan {
    if previews.is_empty() {
        let converted_text = replace_converted_links(original_text, links);
        let markup = build_social_keyboard(links);
        return LinkPlan {
            admin: vec![
                LinkReply::text(format!(
                    "정리 완료.\n선생님.\n{}: {}",
                    username, converted_text
                ))
                .with_markup(markup.clone()),
            ],
            reply: vec![
                LinkReply::text(format!(
                    "정리 완료.\n선생님.\n임베드 링크입니다.\n{}",
                    converted_text
                ))
                .with_markup(markup),
            ],
        };
    }

    let converted_text = replace_converted_links(original_text, links);
    let mut admin = Vec::with_capacity(previews.len() + 1);
    admin.push(
        LinkReply::text(format!(
            "정리 완료.\n선생님.\n{}: {}",
            username, converted_text
        ))
        .with_markup(build_social_keyboard(links))
        .with_disable_preview(true),
    );
    let mut reply = Vec::with_capacity(previews.len());
    for (link, media) in previews {
        let caption = instagram_caption(media.kind);
        let markup = build_instagram_original_keyboard(&link);
        let kind = media.kind;
        let size = media.size;
        let file = instagram_file(media);
        let build = |file: InputFile| match kind {
            InstagramMediaKind::Video => LinkReply::video(file, caption.clone(), size),
            InstagramMediaKind::Photo => LinkReply::photo(file, caption.clone()),
        };
        admin.push(build(file.clone()).with_markup(markup.clone()));
        reply.push(build(file).with_markup(markup));
    }

    LinkPlan { admin, reply }
}

pub async fn handle_threads_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_threads_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let privileged = is_privileged(&bot, &msg, &state, "Threads").await;
    let plan = threads_plan(&display_name(&msg), text, &links);
    deliver_link_plan(&bot, &msg, privileged, "Threads", plan).await
}

fn threads_plan(username: &str, original_text: &str, links: &[LinkConversion]) -> LinkPlan {
    let converted_text = replace_converted_links(original_text, links);
    LinkPlan {
        admin: vec![LinkReply::text(format!(
            "정리 완료.\n선생님.\n{}: {}",
            username, converted_text
        ))],
        reply: vec![LinkReply::text(format!(
            "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n{}",
            converted_text
        ))],
    }
}

pub async fn handle_google_share_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = resolve_google_share_links(text).await;

    if links.is_empty() {
        return Ok(());
    }

    let privileged = is_privileged(&bot, &msg, &state, "구글 공유").await;
    let plan = google_share_plan(&display_name(&msg), &links);
    deliver_link_plan(&bot, &msg, privileged, "구글 공유", plan).await
}

fn google_share_plan(username: &str, links: &[LinkConversion]) -> LinkPlan {
    let message = google_share_message(username, links);
    LinkPlan {
        admin: vec![LinkReply::text(message.clone()).with_parse_mode(ParseMode::Html)],
        reply: vec![LinkReply::text(message).with_parse_mode(ParseMode::Html)],
    }
}

fn replace_converted_links(original_text: &str, links: &[LinkConversion]) -> String {
    let mut text = original_text.to_string();
    for link in links {
        text = text.replace(&link.original, &link.converted);
    }
    text
}

fn music_card_file(png: Vec<u8>) -> InputFile {
    InputFile::memory(png).file_name(MUSIC_CARD_FILE_NAME)
}

fn music_card_caption(username: &str) -> String {
    format!("정리 완료. 선생님.\n{}:", username)
}

fn fits_caption(text: &str) -> bool {
    text.chars().count() <= CAPTION_LIMIT
}

fn build_cleaned_links_text(links: &[MusicLink]) -> String {
    if links.is_empty() {
        return "확인 완료.\n선생님.\n정리된 링크가 없습니다.".to_string();
    }

    let any_tracking = links.iter().any(|link| link.had_tracking);

    if links.len() == 1 {
        if any_tracking {
            format!(
                "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n{}",
                links[0].cleaned
            )
        } else {
            format!(
                "확인 완료.\n선생님.\n음악 링크입니다.\n{}",
                links[0].cleaned
            )
        }
    } else {
        let mut lines = Vec::with_capacity(links.len() + 3);
        if any_tracking {
            lines.push("정리 완료.".to_string());
            lines.push("선생님.".to_string());
            lines.push("추적 파라미터를 제거했습니다.".to_string());
        } else {
            lines.push("확인 완료.".to_string());
            lines.push("선생님.".to_string());
            lines.push("음악 링크입니다.".to_string());
        }
        lines.extend(links.iter().map(|link| link.cleaned.clone()));
        lines.join("\n")
    }
}

fn build_links_keyboard(links: &[MusicLink]) -> Option<InlineKeyboardMarkup> {
    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    let multi = links.len() > 1;
    let mut current_row: Vec<InlineKeyboardButton> = Vec::new();

    for (idx, link) in links.iter().enumerate() {
        let label = if multi {
            format!("링크 #{}", idx + 1)
        } else {
            "링크".to_string()
        };
        match reqwest::Url::parse(&link.cleaned) {
            Ok(parsed) => {
                current_row.push(InlineKeyboardButton::url(label, parsed));
                if current_row.len() == 2 {
                    rows.push(current_row);
                    current_row = Vec::new();
                }
            }
            Err(e) => warn!("음악 URL 파싱 오류: {}, URL: {}", e, link.cleaned),
        }
    }

    if !current_row.is_empty() {
        rows.push(current_row);
    }

    if rows.is_empty() {
        None
    } else {
        Some(InlineKeyboardMarkup::new(rows))
    }
}

fn build_cleaned_message_text(original: &str, links: &[MusicLink]) -> String {
    let mut text = original.to_string();
    for link in links {
        text = text.replace(&link.original, &link.cleaned);
    }
    text
}

fn youtube_cleaned_text(links: &[MusicLink]) -> String {
    if links.len() == 1 {
        links[0].cleaned.clone()
    } else {
        links
            .iter()
            .map(|link| link.cleaned.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn music_links_need_reply(text: &str) -> bool {
    let links = extract_music_links(text);
    !links.is_empty()
        && (!is_youtube_only(&links)
            || links
                .iter()
                .any(|link| link.had_tracking || is_youtube_short_link(&link.original))
            || !(contains_x_link(text)
                || contains_instagram_link(text)
                || contains_threads_link(text)
                || contains_google_share_link(text)
                || extract_gallery_id_from_url(text).is_some()))
}

fn is_youtube_only(links: &[MusicLink]) -> bool {
    !links.is_empty()
        && links
            .iter()
            .all(|link| link.platform == MusicPlatform::YouTube)
}

async fn load_instagram_previews(
    links: &[LinkConversion],
) -> Vec<(LinkConversion, InstagramMedia)> {
    let mut previews = Vec::new();
    for link in links.iter().take(MAX_INSTAGRAM_PREVIEWS) {
        match fetch_instagram_media(&link.cleaned_original).await {
            Ok(media) => previews.push((link.clone(), media)),
            Err(e) => warn!("Instagram 미리보기 수집 실패: {:?}", e),
        }
    }
    previews
}

fn instagram_caption(kind: InstagramMediaKind) -> String {
    let preview = match kind {
        InstagramMediaKind::Video => "릴스 미리보기를 보내드리겠습니다.",
        InstagramMediaKind::Photo => "미리보기를 보내드리겠습니다.",
    };
    format!("정리 완료. 선생님.\n{preview}")
}

fn build_instagram_original_keyboard(link: &LinkConversion) -> Option<InlineKeyboardMarkup> {
    match reqwest::Url::parse(&link.cleaned_original) {
        Ok(original) => Some(InlineKeyboardMarkup::new(vec![vec![
            InlineKeyboardButton::url("원본", original),
        ]])),
        Err(e) => {
            warn!("원본 URL 파싱 오류: {}, URL: {}", e, link.cleaned_original);
            None
        }
    }
}

fn instagram_file(media: InstagramMedia) -> InputFile {
    InputFile::memory(media.bytes).file_name(media.file_name)
}

async fn resolve_google_share_links(text: &str) -> Vec<LinkConversion> {
    let mut links = Vec::new();
    for original in extract_google_share_links(text)
        .into_iter()
        .take(MAX_GOOGLE_SHARE_LINKS)
    {
        match resolve_google_share_link(&original).await {
            Ok(resolved) => links.push(LinkConversion {
                original,
                converted: resolved.clone(),
                cleaned_original: resolved,
                disable_preview: false,
            }),
            Err(err) => warn!("구글 공유 링크 해석 실패({}): {:#}", original, err),
        }
    }
    links
}

fn google_share_message(username: &str, links: &[LinkConversion]) -> String {
    let multi = links.len() > 1;
    let anchors: Vec<String> = links
        .iter()
        .enumerate()
        .map(|(idx, link)| {
            let label = if multi {
                format!("Link #{}", idx + 1)
            } else {
                "Link".to_string()
            };
            html::link(&link.converted, &label)
        })
        .collect();
    format!(
        "정리 완료. 선생님.\n{}: {}",
        html::escape(username),
        anchors.join(" ")
    )
}

fn build_social_keyboard(links: &[LinkConversion]) -> Option<InlineKeyboardMarkup> {
    let mut rows = Vec::new();
    let multi = links.len() > 1;

    for (idx, link) in links.iter().enumerate() {
        let suffix = if multi {
            format!(" #{}", idx + 1)
        } else {
            String::new()
        };
        let embed = match reqwest::Url::parse(&link.converted) {
            Ok(parsed) => parsed,
            Err(e) => {
                warn!("임베드 URL 파싱 오류: {}, URL: {}", e, link.converted);
                continue;
            }
        };
        let original = match reqwest::Url::parse(&link.cleaned_original) {
            Ok(parsed) => parsed,
            Err(e) => {
                warn!("원본 URL 파싱 오류: {}, URL: {}", e, link.cleaned_original);
                continue;
            }
        };
        rows.push(vec![
            InlineKeyboardButton::url(format!("임베드{}", suffix), embed),
            InlineKeyboardButton::url(format!("원본{}", suffix), original),
        ]);
    }

    if rows.is_empty() {
        None
    } else {
        Some(InlineKeyboardMarkup::new(rows))
    }
}

fn display_name(msg: &Message) -> String {
    if let Some(user) = msg.from.as_ref() {
        if let Some(username) = &user.username {
            username.to_string()
        } else {
            user.first_name.clone()
        }
    } else {
        "Unknown".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::urlchanger::delivery::ReplyContent;
    use crate::urlchanger::link_utils::{convert_x_links, extract_music_links};

    fn text_of(reply: &LinkReply) -> &str {
        reply.content.text().expect("text reply")
    }

    fn thumbnail() -> Option<(MusicMetadata, Vec<u8>)> {
        Some((
            MusicMetadata {
                title: "영상 제목".into(),
                artist: Some("채널".into()),
                cover_url: "https://i.ytimg.com/vi/Vc-ByDGOuQE/maxresdefault.jpg".into(),
            },
            vec![0xFF, 0xD8, 0xFF],
        ))
    }

    #[test]
    fn youtube_plan_texts_depend_on_tracking() {
        let links = extract_music_links("https://www.youtube.com/watch?v=Vc-ByDGOuQE&si=abc");
        let tracked = youtube_plan(
            "sensei",
            "https://www.youtube.com/watch?v=Vc-ByDGOuQE&si=abc",
            &links,
            true,
            None,
        )
        .unwrap();
        assert_eq!(
            text_of(&tracked.admin[0]),
            "정리 완료.\n선생님.\nsensei: https://www.youtube.com/watch?v=Vc-ByDGOuQE"
        );
        assert!(text_of(&tracked.reply[0]).contains("추적 파라미터를 제거했습니다."));
        let plain = youtube_plan(
            "sensei",
            "https://www.youtube.com/watch?v=Vc-ByDGOuQE&si=abc",
            &links,
            false,
            thumbnail(),
        )
        .unwrap();
        assert!(reposted(&plain.reply[0]).contains("유튜브 링크입니다."));
        assert!(plain.admin[0].markup.is_some());
    }

    #[test]
    fn youtube_links_are_posted_as_the_thumbnail_with_title_and_channel() {
        let text = "이거 봐 https://www.youtube.com/watch?v=Vc-ByDGOuQE";
        let links = extract_music_links(text);
        let plan = youtube_plan("sensei", text, &links, false, thumbnail()).unwrap();
        let message =
            "확인 완료.\n선생님.\nsensei: 이거 봐 https://www.youtube.com/watch?v=Vc-ByDGOuQE";
        assert_eq!(
            reposted(&plan.admin[0]),
            format!("{message}\n\n영상 제목\n채널")
        );
        assert_eq!(plan.admin[0].content.text_fallback(), Some(message));
        assert!(plan.reply[0].content.text().is_none());
        assert!(reposted(&plan.reply[0]).ends_with("\n\n영상 제목\n채널"));
        assert!(plan.admin[0].markup.is_some() && plan.reply[0].markup.is_some());

        assert!(youtube_plan("sensei", text, &links, false, None).is_none());
        let long = format!(
            "{} https://www.youtube.com/watch?v=Vc-ByDGOuQE",
            "가".repeat(CAPTION_LIMIT)
        );
        let long_links = extract_music_links(&long);
        assert!(youtube_plan("sensei", &long, &long_links, false, thumbnail()).is_none());

        let tracked = format!("{long}&si=abc");
        let tracked_links = extract_music_links(&tracked);
        let plan = youtube_plan("sensei", &tracked, &tracked_links, true, thumbnail()).unwrap();
        assert!(!text_of(&plan.admin[0]).contains("si=abc"));
        assert!(reposted(&plan.reply[0]).ends_with("영상 제목\n채널"));
    }

    #[test]
    fn youtube_short_links_are_reposted_as_full_urls_with_a_preview() {
        for (short, full) in [
            (
                "https://youtu.be/d7hGpiHLSRI",
                "https://www.youtube.com/watch?v=d7hGpiHLSRI",
            ),
            (
                "https://youtube.com/shorts/LDVp294Ty0k",
                "https://www.youtube.com/watch?v=LDVp294Ty0k",
            ),
        ] {
            let links = extract_music_links(short);
            let plan = youtube_plan("sensei", short, &links, false, None).unwrap();
            assert_eq!(
                text_of(&plan.admin[0]),
                format!("정리 완료.\n선생님.\nsensei: {full}")
            );
            assert!(text_of(&plan.reply[0]).ends_with(full));
            assert!(
                plan.reply
                    .iter()
                    .all(|reply| reply.disable_preview != Some(true))
            );
        }
    }

    #[test]
    fn music_plan_uses_card_only_when_caption_fits() {
        let links =
            extract_music_links("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x");
        let with_card = music_plan(
            "sensei",
            "링크 https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x",
            &links,
            Some(vec![1, 2, 3]),
        );
        assert!(with_card.admin[0].content.text().is_none());
        assert_eq!(
            with_card.admin[0].content.text_fallback(),
            Some(
                "정리 완료.\n선생님.\nsensei: 링크 https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
            )
        );
        assert!(
            with_card.reply[0]
                .content
                .text_fallback()
                .unwrap()
                .contains("추적 파라미터를 제거했습니다.")
        );

        let long_name = "x".repeat(CAPTION_LIMIT);
        let too_long = music_plan(&long_name, "q", &links, Some(vec![1]));
        assert!(too_long.admin[0].content.text().is_some());

        let without_card = music_plan("sensei", "q", &links, None);
        assert!(
            without_card.reply[0]
                .content
                .text()
                .unwrap()
                .contains("open.spotify.com")
        );
    }

    fn reposted(reply: &LinkReply) -> String {
        match &reply.content {
            ReplyContent::Text(text) => text.clone(),
            ReplyContent::Photo { caption, .. } | ReplyContent::Video { caption, .. } => {
                caption.clone()
            }
        }
    }

    #[test]
    fn admin_reposts_keep_the_users_words_and_other_links() {
        let youtube = "이 노래 좋다 https://youtu.be/d7hGpiHLSRI?si=abc";
        let plan =
            youtube_plan("sensei", youtube, &extract_music_links(youtube), true, None).unwrap();
        assert!(
            reposted(&plan.admin[0])
                .contains("이 노래 좋다 https://www.youtube.com/watch?v=d7hGpiHLSRI")
        );

        let spotify = "출근길 추천 https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x 그리고 https://x.com/u/status/1";
        let plan = music_plan(
            "sensei",
            spotify,
            &extract_music_links(spotify),
            Some(vec![1]),
        );
        let caption = reposted(&plan.admin[0]);
        assert!(caption.contains("출근길 추천") && caption.contains("https://x.com/u/status/1"));

        let instagram = "둘 다 봐 https://www.instagram.com/p/AAAAAAAAAAA/ https://www.instagram.com/p/BBBBBBBBBBB/";
        let links = convert_instagram_links(instagram);
        let media = InstagramMedia {
            kind: InstagramMediaKind::Photo,
            bytes: vec![0xFF, 0xD8, 0xFF],
            file_name: "instagram.jpg",
            size: None,
        };
        let plan = instagram_plan("sensei", instagram, &links, vec![(links[0].clone(), media)]);
        let lead = reposted(&plan.admin[0]);
        assert!(lead.contains("sensei: 둘 다 봐") && lead.contains("BBBBBBBBBBB"));
        assert_eq!(plan.admin.len(), 2);
    }

    #[test]
    fn a_clean_youtube_link_is_handled_unless_another_link_handler_owns_the_message() {
        assert!(!music_links_need_reply(
            "https://www.youtube.com/watch?v=d7hGpiHLSRI https://x.com/user/status/123?s=20"
        ));
        assert!(!music_links_need_reply(
            "https://www.youtube.com/watch?v=d7hGpiHLSRI https://www.instagram.com/p/abc/"
        ));
        assert!(!music_links_need_reply(
            "https://hitomi.la/galleries/1234567.html https://www.youtube.com/watch?v=d7hGpiHLSRI"
        ));
        assert!(music_links_need_reply(
            "이거 봐 https://www.youtube.com/watch?v=d7hGpiHLSRI"
        ));
        assert!(!music_links_need_reply("유튜브 얘기"));
        assert!(music_links_need_reply("https://youtu.be/d7hGpiHLSRI"));
        assert!(music_links_need_reply(
            "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
        ));
    }

    #[test]
    fn x_plan_disables_preview_for_dot_prefixed_links() {
        let links = convert_x_links(".https://x.com/user/status/1?s=1");
        let plan = x_plan("sensei", ".https://x.com/user/status/1?s=1", &links);
        assert_eq!(plan.admin[0].disable_preview, Some(true));
        assert_eq!(plan.reply[0].disable_preview, Some(true));
        assert!(text_of(&plan.admin[0]).contains("fxtwitter.com/user/status/1"));
        assert!(text_of(&plan.reply[0]).starts_with("정리 완료.\n선생님.\n임베드 링크입니다."));
    }

    #[test]
    fn google_share_plan_sends_html_links_in_both_modes() {
        let links = vec![LinkConversion {
            original: "https://share.google/abc".into(),
            converted: "https://www.yna.co.kr/view/AKR1".into(),
            cleaned_original: "https://www.yna.co.kr/view/AKR1".into(),
            disable_preview: false,
        }];
        let plan = google_share_plan("sensei", &links);
        for reply in plan.admin.iter().chain(plan.reply.iter()) {
            assert_eq!(reply.parse_mode, Some(ParseMode::Html));
            assert!(
                text_of(reply).contains("<a href=\"https://www.yna.co.kr/view/AKR1\">Link</a>")
            );
        }
    }

    #[test]
    fn instagram_plan_falls_back_to_text_without_previews() {
        let links = convert_instagram_links("https://www.instagram.com/p/abc/?igsh=1");
        let plan = instagram_plan(
            "sensei",
            "https://www.instagram.com/p/abc/?igsh=1",
            &links,
            Vec::new(),
        );
        assert_eq!(plan.admin.len(), 1);
        assert!(text_of(&plan.admin[0]).contains(&links[0].converted));
        assert!(!text_of(&plan.admin[0]).contains("igsh=1"));
        assert!(text_of(&plan.reply[0]).contains("임베드 링크입니다."));
    }
}
