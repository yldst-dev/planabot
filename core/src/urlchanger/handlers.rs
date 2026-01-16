use crate::bot::{AppState, HandlerResult, SendOptions, send_in_thread, send_reply_with_fallback};
use crate::urlchanger::link_utils::{
    LinkConversion, MusicPlatform, contains_instagram_link, contains_music_link, contains_x_link,
    convert_instagram_links, convert_x_links, extract_music_links,
};
use crate::urlchanger::music_resolver::{ResolvedMusicLink, music_http, resolve_music_links};
use log::{error, warn};
use teloxide::dispatching::DpHandlerDescription;
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup};

pub fn url_handlers<B>() -> Handler<'static, HandlerResult, DpHandlerDescription>
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetUpdates: Send,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    Update::filter_message().branch(
        dptree::filter(|msg: Message, state: AppState| state.is_after_boot(&msg))
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
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = extract_music_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let resolved_links = resolve_music_links(music_http(), &links).await;
    let youtube_only = is_youtube_only(&resolved_links);
    let youtube_music_only = is_youtube_music_only(&resolved_links);
    let youtube_music_had_tracking = youtube_music_only
        && resolved_links.iter().any(|link| link.had_tracking);

    let chat_member = match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member,
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생: {:?}", e);
            return handle_without_admin_rights(&bot, &msg, &resolved_links).await;
        }
    };

    if youtube_only && chat_member.kind.is_privileged() {
        return handle_youtube_with_admin_rights(&bot, &msg, &resolved_links).await;
    }
    if youtube_only {
        return handle_youtube_without_admin_rights(&bot, &msg, &resolved_links).await;
    }
    if youtube_music_only && chat_member.kind.is_privileged() {
        return handle_youtube_music_with_admin_rights(
            &bot,
            &msg,
            &resolved_links,
            youtube_music_had_tracking,
        )
        .await;
    }
    if youtube_music_only {
        return handle_youtube_music_without_admin_rights(
            &bot,
            &msg,
            &resolved_links,
            youtube_music_had_tracking,
        )
        .await;
    }

    if chat_member.kind.is_privileged() {
        handle_with_admin_rights(&bot, &msg, &resolved_links).await
    } else {
        handle_without_admin_rights(&bot, &msg, &resolved_links).await
    }
}

async fn handle_with_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[ResolvedMusicLink],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("메시지 삭제 실패: {:?}", e);
        return handle_without_admin_rights(bot, msg, links).await;
    }

    let username = display_name(msg);
    let cleaned_text = build_cleaned_message_text(msg.text().unwrap_or(""), links);
    let message = format!("{}: {}", username, cleaned_text);
    let reply_markup = build_music_keyboard(links, false);

    let mut request = send_in_thread(bot, msg, message);
    if let Some(markup) = reply_markup {
        request = request.reply_markup(markup);
    }
    request.await?;

    Ok(())
}

async fn handle_youtube_with_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[ResolvedMusicLink],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("메시지 삭제 실패(유튜브): {:?}", e);
        return handle_youtube_without_admin_rights(bot, msg, links).await;
    }

    let username = display_name(msg);
    let cleaned_text = youtube_cleaned_text(links);
    let message = if cleaned_text.contains('\n') {
        format!("{}:\n{}", username, cleaned_text)
    } else {
        format!("{}: {}", username, cleaned_text)
    };

    send_in_thread(bot, msg, message).await?;
    Ok(())
}

async fn handle_youtube_music_with_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[ResolvedMusicLink],
    had_tracking: bool,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("메시지 삭제 실패(유튜브 뮤직): {:?}", e);
        return handle_youtube_music_without_admin_rights(bot, msg, links, had_tracking).await;
    }

    let username = display_name(msg);
    let cleaned_text = youtube_cleaned_text(links);
    let message = if cleaned_text.contains('\n') {
        format!("{}:\n{}", username, cleaned_text)
    } else {
        format!("{}: {}", username, cleaned_text)
    };
    let reply_markup = build_music_keyboard(links, true);

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
    links: &[ResolvedMusicLink],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let text = build_cleaned_links_text(links);
    let markup = build_music_keyboard(links, false);

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

async fn handle_youtube_without_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[ResolvedMusicLink],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let markup = build_youtube_keyboard(links);
    send_reply_with_fallback(
        bot,
        msg,
        "추적 파라미터가 제거되었습니다.",
        SendOptions {
            reply_markup: markup,
            ..SendOptions::default()
        },
    )
    .await?;

    Ok(())
}

async fn handle_youtube_music_without_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[ResolvedMusicLink],
    had_tracking: bool,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let text = if had_tracking {
        "추적 파라미터가 제거되었습니다."
    } else {
        "음악 플랫폼 링크입니다."
    };
    let markup = build_music_keyboard(links, true);
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

fn build_cleaned_links_text(links: &[ResolvedMusicLink]) -> String {
    if links.is_empty() {
        return "정리된 링크가 없습니다.".to_string();
    }

    if links.len() == 1 {
        format!("추적 파라미터 제거된 링크:\n{}", links[0].cleaned)
    } else {
        let mut lines = Vec::with_capacity(links.len());
        for (idx, link) in links.iter().enumerate() {
            lines.push(format!("{}. {}", idx + 1, link.cleaned));
        }
        format!("추적 파라미터 제거된 링크:\n{}", lines.join("\n"))
    }
}

fn build_music_keyboard(
    links: &[ResolvedMusicLink],
    include_original: bool,
) -> Option<InlineKeyboardMarkup> {
    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    let multi = links.len() > 1;

    for (idx, link) in links.iter().enumerate() {
        let suffix = if multi {
            format!(" #{}", idx + 1)
        } else {
            String::new()
        };
        let mut current_row: Vec<InlineKeyboardButton> = Vec::new();
        for platform in music_platform_order() {
            if !include_original && platform == link.platform {
                continue;
            }
            let Some(url) = link.platform_links.get(&platform) else {
                continue;
            };
            match reqwest::Url::parse(url) {
                Ok(parsed) => {
                    let label = format!("{}{}", platform_label(platform), suffix);
                    current_row.push(InlineKeyboardButton::url(label, parsed));
                    if current_row.len() == 2 {
                        rows.push(current_row);
                        current_row = Vec::new();
                    }
                }
                Err(e) => warn!("플랫폼 URL 파싱 오류: {}, URL: {}", e, url),
            }
        }
        if !current_row.is_empty() {
            rows.push(current_row);
        }
    }

    if rows.is_empty() {
        None
    } else {
        Some(InlineKeyboardMarkup::new(rows))
    }
}

fn build_youtube_keyboard(links: &[ResolvedMusicLink]) -> Option<InlineKeyboardMarkup> {
    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    let multi = links.len() > 1;
    let mut current_row: Vec<InlineKeyboardButton> = Vec::new();

    for (idx, link) in links.iter().enumerate() {
        let label = if multi {
            format!("유튜브 #{}", idx + 1)
        } else {
            "유튜브".to_string()
        };
        match reqwest::Url::parse(&link.cleaned) {
            Ok(parsed) => {
                current_row.push(InlineKeyboardButton::url(label, parsed));
                if current_row.len() == 2 {
                    rows.push(current_row);
                    current_row = Vec::new();
                }
            }
            Err(e) => warn!("유튜브 URL 파싱 오류: {}, URL: {}", e, link.cleaned),
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

fn music_platform_order() -> [MusicPlatform; 4] {
    [
        MusicPlatform::Spotify,
        MusicPlatform::YouTubeMusic,
        MusicPlatform::YouTube,
        MusicPlatform::AppleMusic,
    ]
}

fn platform_label(platform: MusicPlatform) -> &'static str {
    match platform {
        MusicPlatform::Spotify => "스포티파이",
        MusicPlatform::YouTubeMusic => "유튜브 뮤직",
        MusicPlatform::YouTube => "유튜브",
        MusicPlatform::AppleMusic => "애플 뮤직",
    }
}

fn build_cleaned_message_text(original: &str, links: &[ResolvedMusicLink]) -> String {
    let mut text = original.to_string();
    for link in links {
        text = text.replace(&link.original, &link.cleaned);
    }
    text
}

fn youtube_cleaned_text(links: &[ResolvedMusicLink]) -> String {
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

fn is_youtube_only(links: &[ResolvedMusicLink]) -> bool {
    !links.is_empty()
        && links
            .iter()
            .all(|link| link.platform == MusicPlatform::YouTube)
}

fn is_youtube_music_only(links: &[ResolvedMusicLink]) -> bool {
    !links.is_empty()
        && links
            .iter()
            .all(|link| link.platform == MusicPlatform::YouTubeMusic)
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

    send_in_thread(bot, msg, format!("{}: {}", username, converted_text))
        .disable_link_preview(disable_preview)
        .await?;

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

    send_reply_with_fallback(
        bot,
        msg,
        format!("임베드용 링크:\n{}", converted_text),
        SendOptions {
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
    links: &[(String, String)],
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
    for (original, converted) in links {
        converted_text = converted_text.replace(original, converted);
    }

    send_in_thread(bot, msg, format!("{}: {}", username, converted_text)).await?;

    Ok(())
}

async fn handle_instagram_without_admin<B>(
    bot: &B,
    msg: &Message,
    links: &[(String, String)],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
{
    let mut converted_text = msg.text().unwrap_or("").to_string();
    for (original, converted) in links {
        converted_text = converted_text.replace(original, converted);
    }

    send_reply_with_fallback(
        bot,
        msg,
        format!("임베드용 링크:\n{}", converted_text),
        SendOptions::default(),
    )
    .await?;

    Ok(())
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
