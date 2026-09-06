use crate::bot::{
    AppState, HandlerResult, SendOptions, send_in_thread, send_photo_in_thread,
    send_photo_reply_with_fallback, send_reply_with_fallback,
};
use crate::urlchanger::link_utils::{
    LinkConversion, MusicLink, MusicPlatform, contains_instagram_link, contains_music_link,
    contains_threads_link, contains_x_link, convert_instagram_links, convert_threads_links,
    convert_x_links, extract_music_links,
};
use crate::urlchanger::music_card::build_music_card;
use chrono::Utc;
use log::{error, warn};
use teloxide::dispatching::DpHandlerDescription;
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup, InputFile};

const CAPTION_LIMIT: usize = 1024;
const MUSIC_CARD_FILE_NAME: &str = "music_card.png";

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
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_instagram_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let chat_member = match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member,
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생(Instagram): {:?}", e);
            return handle_instagram_without_admin(&bot, &msg, &links).await;
        }
    };

    if chat_member.kind.is_privileged() {
        handle_instagram_with_admin(&bot, &msg, &links).await
    } else {
        handle_instagram_without_admin(&bot, &msg, &links).await
    }
}

async fn handle_instagram_with_admin<B>(
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
        warn!("Instagram 메시지 삭제 실패: {:?}", e);
        return handle_instagram_without_admin(bot, msg, links).await;
    }

    let username = display_name(msg);
    let mut converted_text = msg.text().unwrap_or("").to_string();
    for link in links {
        converted_text = converted_text.replace(&link.original, &link.converted);
    }
    let reply_markup = build_social_keyboard(links);

    let mut request = send_in_thread(
        bot,
        msg,
        format!("정리 완료.\n선생님.\n{}: {}", username, converted_text),
    );
    if let Some(markup) = reply_markup {
        request = request.reply_markup(markup);
    }
    request.await?;

    Ok(())
}

async fn handle_instagram_without_admin<B>(
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
            "정리 완료.\n선생님.\n임베드 링크입니다.\n{}",
            converted_text
        ),
        SendOptions {
            reply_markup: build_social_keyboard(links),
            ..SendOptions::default()
        },
    )
    .await?;

    Ok(())
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
