use crate::bot::{AppState, HandlerResult, SendOptions, send_reply_with_fallback, send_in_thread};
use crate::urlchanger::link_utils::{
    LinkConversion, contains_instagram_link, contains_music_link, contains_x_link,
    convert_instagram_links, convert_x_links, extract_music_links,
};
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
{
    Update::filter_message()
        .branch(
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
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = extract_music_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let chat_member = match bot
        .get_chat_member(msg.chat.id, bot.get_me().await?.id)
        .await
    {
        Ok(member) => member,
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생: {:?}", e);
            return handle_without_admin_rights(&bot, &msg, &links).await;
        }
    };

    if chat_member.kind.is_privileged() {
        handle_with_admin_rights(&bot, &msg, &links).await
    } else {
        handle_without_admin_rights(&bot, &msg, &links).await
    }
}

async fn handle_with_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[(String, String)],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
{
    if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
        warn!("메시지 삭제 실패: {:?}", e);
        return handle_without_admin_rights(bot, msg, links).await;
    }

    let username = display_name(msg);
    let mut cleaned_text = msg.text().unwrap_or("").to_string();

    for (original, cleaned) in links {
        cleaned_text = cleaned_text.replace(original, cleaned);
    }

    send_in_thread(bot, msg, format!("{}: {}", username, cleaned_text)).await?;

    Ok(())
}

async fn handle_without_admin_rights<B>(
    bot: &B,
    msg: &Message,
    links: &[(String, String)],
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: Send + Sync + 'static,
{
    let mut keyboard = Vec::new();

    for (i, (_, cleaned)) in links.iter().enumerate() {
        match reqwest::Url::parse(cleaned) {
            Ok(url) => {
                let row = vec![InlineKeyboardButton::url(
                    format!("정리된 링크 #{}", i + 1),
                    url,
                )];
                keyboard.push(row);
            }
            Err(e) => warn!("URL 파싱 오류: {}, URL: {}", e, cleaned),
        }
    }

    if keyboard.is_empty() {
        return Ok(());
    }

    let markup = InlineKeyboardMarkup::new(keyboard);

    send_reply_with_fallback(
        bot,
        msg,
        "추적 파라미터가 제거된 링크:",
        SendOptions {
            reply_markup: Some(markup),
            ..SendOptions::default()
        },
    )
    .await?;

    Ok(())
}

pub async fn handle_x_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_x_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let chat_member = match bot
        .get_chat_member(msg.chat.id, bot.get_me().await?.id)
        .await
    {
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
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_instagram_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let chat_member = match bot
        .get_chat_member(msg.chat.id, bot.get_me().await?.id)
        .await
    {
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
