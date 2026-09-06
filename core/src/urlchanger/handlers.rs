use crate::bot::{
    AppState, HandlerResult, SendOptions, send_in_thread, send_photo_in_thread,
    send_photo_reply_with_fallback, send_reply_with_fallback, send_video_in_thread,
    send_video_reply_with_fallback,
};
use crate::urlchanger::google_share::resolve_google_share_link;
use crate::urlchanger::instagram::{InstagramMedia, InstagramMediaKind, fetch_instagram_media};
use crate::urlchanger::link_utils::{
    LinkConversion, MusicLink, MusicPlatform, contains_google_share_link, contains_instagram_link,
    contains_music_link, contains_threads_link, contains_x_link, convert_instagram_links,
    convert_threads_links, convert_x_links, extract_google_share_links, extract_music_links,
};
use crate::urlchanger::music_card::build_music_card;
use chrono::Utc;
use log::{error, warn};
use teloxide::dispatching::DpHandlerDescription;
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup, InputFile, ParseMode};
use teloxide::utils::html;

const CAPTION_LIMIT: usize = 1024;
const MUSIC_CARD_FILE_NAME: &str = "music_card.png";
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
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_music_link(msg.text().unwrap())
            })
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

pub async fn handle_music_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = extract_music_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let youtube_only = is_youtube_only(&links);
    let any_tracking = links.iter().any(|link| link.had_tracking);

    if youtube_only && !any_tracking {
        return Ok(());
    }

    let privileged = match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member.kind.is_privileged(),
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생: {:?}", e);
            false
        }
    };

    if youtube_only {
        return if privileged {
            handle_youtube_with_admin_rights(&bot, &msg, &links).await
        } else {
            handle_youtube_without_admin_rights(&bot, &msg, &links, any_tracking).await
        };
    }

    let card = build_music_card(&links).await;

    if privileged {
        handle_with_admin_rights(&bot, &msg, &links, card).await
    } else {
        handle_without_admin_rights(&bot, &msg, &links, card).await
    }
}

async fn handle_with_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[MusicLink],
    card: Option<Vec<u8>>,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("메시지 삭제 실패: {:?}", e);
        return handle_without_admin_rights(bot, msg, links, card).await;
    }

    let username = display_name(msg);
    let cleaned_text = build_cleaned_message_text(msg.text().unwrap_or(""), links);
    let message = format!("정리 완료.\n선생님.\n{}: {}", username, cleaned_text);
    let caption = music_card_caption(&username);
    let reply_markup = build_links_keyboard(links);

    if let Some(png) = card.filter(|_| fits_caption(&caption)) {
        let mut request = send_photo_in_thread(bot, msg, music_card_file(png)).caption(caption);
        if let Some(markup) = reply_markup.clone() {
            request = request.reply_markup(markup);
        }
        match request.await {
            Ok(_) => return Ok(()),
            Err(e) => warn!("음악 카드 전송 실패, 텍스트로 대체합니다: {:?}", e),
        }
    }

    let mut request = send_in_thread(bot, msg, message);
    if let Some(markup) = reply_markup {
        request = request.reply_markup(markup);
    }
    request.await?;

    Ok(())
}

async fn handle_without_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[MusicLink],
    card: Option<Vec<u8>>,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
{
    let text = build_cleaned_links_text(links);
    let opts = SendOptions {
        reply_markup: build_links_keyboard(links),
        ..SendOptions::default()
    };

    let caption = music_card_caption(&display_name(msg));

    if let Some(png) = card.filter(|_| fits_caption(&caption)) {
        match send_photo_reply_with_fallback(bot, msg, music_card_file(png), caption, opts.clone())
            .await
        {
            Ok(_) => return Ok(()),
            Err(e) => warn!("음악 카드 답장 실패, 텍스트로 대체합니다: {:?}", e),
        }
    }

    send_reply_with_fallback(bot, msg, text, opts).await?;

    Ok(())
}

async fn handle_youtube_with_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[MusicLink],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("메시지 삭제 실패(유튜브): {:?}", e);
        let had_tracking = links.iter().any(|link| link.had_tracking);
        return handle_youtube_without_admin_rights(bot, msg, links, had_tracking).await;
    }

    let username = display_name(msg);
    let cleaned_text = youtube_cleaned_text(links);
    let message = if cleaned_text.contains('\n') {
        format!("정리 완료.\n선생님.\n{}:\n{}", username, cleaned_text)
    } else {
        format!("정리 완료.\n선생님.\n{}: {}", username, cleaned_text)
    };
    let reply_markup = build_links_keyboard(links);
    let mut request = send_in_thread(bot, msg, message);
    if let Some(markup) = reply_markup {
        request = request.reply_markup(markup);
    }
    request.await?;
    Ok(())
}

async fn handle_youtube_without_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[MusicLink],
    had_tracking: bool,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let markup = build_links_keyboard(links);
    let text = if had_tracking {
        "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n확인 바랍니다."
    } else {
        "확인 완료.\n선생님.\n유튜브 링크입니다.\n원본 링크 버튼을 제공합니다."
    };
    send_reply_with_fallback(
        bot,
        msg,
        text,
        SendOptions {
            reply_markup: markup,
            ..SendOptions::default()
        },
    )
    .await?;

    Ok(())
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

fn is_youtube_only(links: &[MusicLink]) -> bool {
    !links.is_empty()
        && links
            .iter()
            .all(|link| link.platform == MusicPlatform::YouTube)
}

pub async fn handle_x_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_x_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let chat_member = match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member,
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생(X): {:?}", e);
            return handle_x_without_admin(&bot, &msg, &links).await;
        }
    };

    if chat_member.kind.is_privileged() {
        handle_x_with_admin(&bot, &msg, &links).await
    } else {
        handle_x_without_admin(&bot, &msg, &links).await
    }
}

async fn handle_x_with_admin<B>(bot: &B, msg: &Message, links: &[LinkConversion]) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("X 메시지 삭제 실패: {:?}", e);
        return handle_x_without_admin(bot, msg, links).await;
    }

    let username = display_name(msg);
    let mut converted_text = msg.text().unwrap_or("").to_string();
    for link in links {
        converted_text = converted_text.replace(&link.original, &link.converted);
    }

    let disable_preview = links.iter().any(|l| l.disable_preview);
    let markup = build_social_keyboard(links);

    let mut request = send_in_thread(
        bot,
        msg,
        format!("정리 완료.\n선생님.\n{}: {}", username, converted_text),
    )
    .disable_link_preview(disable_preview);
    if let Some(markup) = markup {
        request = request.reply_markup(markup);
    }
    request.await?;

    Ok(())
}

async fn handle_x_without_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let mut converted_text = msg.text().unwrap_or("").to_string();
    for link in links {
        converted_text = converted_text.replace(&link.original, &link.converted);
    }

    let disable_preview = links.iter().any(|l| l.disable_preview);
    let markup = build_social_keyboard(links);

    send_reply_with_fallback(
        bot,
        msg,
        format!(
            "정리 완료.\n선생님.\n임베드 링크입니다.\n{}",
            converted_text
        ),
        SendOptions {
            reply_markup: markup,
            disable_preview: Some(disable_preview),
            ..SendOptions::default()
        },
    )
    .await?;

    Ok(())
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

    let chat_member = match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member,
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생(Instagram): {:?}", e);
            return handle_instagram_without_admin(&bot, &msg, &links, previews).await;
        }
    };

    if chat_member.kind.is_privileged() {
        handle_instagram_with_admin(&bot, &msg, &links, previews).await
    } else {
        handle_instagram_without_admin(&bot, &msg, &links, previews).await
    }
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

async fn handle_instagram_with_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
    previews: Vec<(LinkConversion, InstagramMedia)>,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("Instagram 메시지 삭제 실패: {:?}", e);
        return handle_instagram_without_admin(bot, msg, links, previews).await;
    }

    if previews.is_empty() {
        return send_instagram_link_fallback(bot, msg, links, true).await;
    }

    for (link, media) in previews {
        let caption = instagram_caption(media.kind);
        let opts = SendOptions {
            reply_markup: build_instagram_original_keyboard(&link),
            ..SendOptions::default()
        };
        send_instagram_preview_in_thread(bot, msg, media, caption, opts).await?;
    }

    Ok(())
}

async fn handle_instagram_without_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
    previews: Vec<(LinkConversion, InstagramMedia)>,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    if previews.is_empty() {
        return send_instagram_link_fallback(bot, msg, links, false).await;
    }

    for (link, media) in previews {
        let caption = instagram_caption(media.kind);
        let opts = SendOptions {
            reply_markup: build_instagram_original_keyboard(&link),
            ..SendOptions::default()
        };
        send_instagram_preview_reply(bot, msg, media, caption, opts).await?;
    }

    Ok(())
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

async fn send_instagram_preview_in_thread<B>(
    bot: &B,
    msg: &Message,
    media: InstagramMedia,
    caption: String,
    opts: SendOptions,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    match media.kind {
        InstagramMediaKind::Video => {
            let mut request =
                send_video_in_thread(bot, msg, instagram_file(media)).supports_streaming(true);
            if !caption.is_empty() {
                request = request.caption(caption);
            }
            if let Some(markup) = opts.reply_markup {
                request = request.reply_markup(markup);
            }
            request.await?;
        }
        InstagramMediaKind::Photo => {
            let mut request = send_photo_in_thread(bot, msg, instagram_file(media));
            if !caption.is_empty() {
                request = request.caption(caption);
            }
            if let Some(markup) = opts.reply_markup {
                request = request.reply_markup(markup);
            }
            request.await?;
        }
    }
    Ok(())
}

async fn send_instagram_preview_reply<B>(
    bot: &B,
    msg: &Message,
    media: InstagramMedia,
    caption: String,
    opts: SendOptions,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    match media.kind {
        InstagramMediaKind::Video => {
            send_video_reply_with_fallback(bot, msg, instagram_file(media), caption, opts).await?;
        }
        InstagramMediaKind::Photo => {
            send_photo_reply_with_fallback(bot, msg, instagram_file(media), caption, opts).await?;
        }
    }
    Ok(())
}

async fn send_instagram_link_fallback<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
    in_thread: bool,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let username = display_name(msg);
    let mut converted_text = msg.text().unwrap_or("").to_string();
    for link in links {
        converted_text = converted_text.replace(&link.original, &link.converted);
    }
    let markup = build_social_keyboard(links);

    if in_thread {
        let mut request = send_in_thread(
            bot,
            msg,
            format!("정리 완료.\n선생님.\n{}: {}", username, converted_text),
        );
        if let Some(markup) = markup {
            request = request.reply_markup(markup);
        }
        request.await?;
        Ok(())
    } else {
        send_reply_with_fallback(
            bot,
            msg,
            format!(
                "정리 완료.\n선생님.\n임베드 링크입니다.\n{}",
                converted_text
            ),
            SendOptions {
                reply_markup: markup,
                ..SendOptions::default()
            },
        )
        .await?;
        Ok(())
    }
}

pub async fn handle_threads_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_threads_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let chat_member = match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member,
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생(Threads): {:?}", e);
            return handle_threads_without_admin(&bot, &msg, &links).await;
        }
    };

    if chat_member.kind.is_privileged() {
        handle_threads_with_admin(&bot, &msg, &links).await
    } else {
        handle_threads_without_admin(&bot, &msg, &links).await
    }
}

async fn handle_threads_with_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("Threads 메시지 삭제 실패: {:?}", e);
        return handle_threads_without_admin(bot, msg, links).await;
    }

    let username = display_name(msg);
    let mut converted_text = msg.text().unwrap_or("").to_string();
    for link in links {
        converted_text = converted_text.replace(&link.original, &link.converted);
    }

    let request = send_in_thread(
        bot,
        msg,
        format!("정리 완료.\n선생님.\n{}: {}", username, converted_text),
    );
    request.await?;

    Ok(())
}

async fn handle_threads_without_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let mut converted_text = msg.text().unwrap_or("").to_string();
    for link in links {
        converted_text = converted_text.replace(&link.original, &link.converted);
    }

    send_reply_with_fallback(
        bot,
        msg,
        format!(
            "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n{}",
            converted_text
        ),
        SendOptions {
            ..SendOptions::default()
        },
    )
    .await?;

    Ok(())
}

pub async fn handle_google_share_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = resolve_google_share_links(text).await;

    if links.is_empty() {
        return Ok(());
    }

    let chat_member = match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member,
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생(구글 공유): {:?}", e);
            return handle_google_share_without_admin(&bot, &msg, &links).await;
        }
    };

    if chat_member.kind.is_privileged() {
        handle_google_share_with_admin(&bot, &msg, &links).await
    } else {
        handle_google_share_without_admin(&bot, &msg, &links).await
    }
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

async fn handle_google_share_with_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("구글 공유 메시지 삭제 실패: {:?}", e);
        return handle_google_share_without_admin(bot, msg, links).await;
    }

    send_in_thread(bot, msg, google_share_message(&display_name(msg), links))
        .parse_mode(ParseMode::Html)
        .await?;

    Ok(())
}

async fn handle_google_share_without_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[LinkConversion],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    send_reply_with_fallback(
        bot,
        msg,
        google_share_message(&display_name(msg), links),
        SendOptions {
            parse_mode: Some(ParseMode::Html),
            ..SendOptions::default()
        },
    )
    .await?;

    Ok(())
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
