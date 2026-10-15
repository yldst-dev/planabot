use std::time::Duration;

use log::{error, warn};
use teloxide::prelude::*;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup, Message, MessageId, ParseMode};
use url::Url;

use super::super::gallery::{
    GalleryIdSource, build_gallery_keyboard, extract_gallery_id, is_private_chat,
    render_gallery_message, render_gallery_message_for_user,
};
use super::super::notice::{
    NoticeCopies, NoticeFailure, notice_failure, request_error, retry_after,
};
use super::super::telegram::{SendOptions, send_reply_with_fallback};
use super::super::{AppState, HandlerResult};

const NOTICE_ALBUM_SETTLE: Duration = Duration::from_millis(1500);

pub(crate) async fn handle_message<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    if !state.is_after_boot(&msg) {
        return Ok(());
    }

    state.record_group_chat(&msg).await;

    let text = match msg.text() {
        Some(t) => t.trim(),
        None => return Ok(()),
    };

    let Some(gallery_match) = extract_gallery_id(text, &msg, &state.bot_username) else {
        return Ok(());
    };

    let gallery_id = gallery_match.id.clone();

    let mut use_user_header = false;
    if gallery_match.source == GalleryIdSource::Url && !is_private_chat(&msg) {
        match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
            Ok(chat_member) => {
                if chat_member.kind.is_privileged() {
                    if let Err(err) = bot.delete_message(msg.chat.id, msg.id).await {
                        warn!("갤러리 URL 메시지 삭제 실패: {:?}", err);
                    } else {
                        use_user_header = true;
                    }
                }
            }
            Err(err) => {
                error!("관리자 권한 확인 중 오류 발생 (갤러리 URL): {:?}", err);
            }
        }
    }

    let chat_id = msg.chat.id;
    let initial = send_reply_with_fallback(
        &bot,
        &msg,
        format!(
            "검색 시작.\n선생님.\nID {} 조회 중입니다.\n잠시만 대기해 주십시오.",
            gallery_id
        ),
        SendOptions {
            disable_notification: Some(true),
            ..SendOptions::default()
        },
    )
    .await?;

    let info = match state.gallery_client.get_gallery_info(&gallery_id).await {
        Ok(info) => info,
        Err(err) => {
            error!("갤러리 조회 실패 (ID {}): {}", gallery_id, err);
            let _ = bot
                .edit_message_text(
                    chat_id,
                    initial.id,
                    "오류.\n선생님.\n갤러리 정보를 불러오지 못했습니다.\n잠시 후 다시 시도해 주십시오.",
                )
                .await;
            return Ok(());
        }
    };

    match info {
        Some(info) => {
            let response = if use_user_header {
                msg.from
                    .as_ref()
                    .map(|user| {
                        let display = user
                            .username
                            .clone()
                            .unwrap_or_else(|| user.first_name.clone());
                        render_gallery_message_for_user(&info, false, &display)
                    })
                    .unwrap_or_else(|| render_gallery_message(&info, false))
            } else {
                render_gallery_message(&info, false)
            };
            let keyboard = build_gallery_keyboard(&info, !is_private_chat(&msg));

            if let Err(err) = bot
                .edit_message_text(chat_id, initial.id, response)
                .parse_mode(ParseMode::Html)
                .reply_markup(keyboard)
                .await
            {
                error!("메시지 수정 실패 (ID {}): {}", gallery_id, err);
            }
        }
        None => {
            let error_text = format!(
                "확인 필요.\n선생님.\nID {} 정보를 찾지 못했습니다.\n제목 데이터가 누락되었을 수 있습니다.",
                gallery_id
            );

            if let Err(err) = bot.edit_message_text(chat_id, initial.id, error_text).await {
                error!("오류 메시지 수정 실패 (ID {}): {}", gallery_id, err);
            }
        }
    }

    Ok(())
}

pub(crate) async fn handle_notice_post<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::CopyMessage: Send,
    B::CopyMessages: Send,
{
    if state.notice_chat_id != Some(msg.chat.id) || !state.notices.claim(msg.chat.id, msg.id).await
    {
        return Ok(());
    }

    let Some(group) = msg.media_group_id().map(|group| group.0.clone()) else {
        let _turn = state.notices.turn.lock().await;
        broadcast_notice(&bot, &state, msg.chat.id, vec![msg.id]).await;
        return Ok(());
    };
    if !state.notices.add_album_item(&group, msg.id) {
        return Ok(());
    }
    let turn = state.notices.turn.clone().lock_owned().await;
    tokio::spawn(async move {
        tokio::time::sleep(NOTICE_ALBUM_SETTLE).await;
        let ids = state.notices.take_album(&group);
        broadcast_notice(&bot, &state, msg.chat.id, ids).await;
        drop(turn);
    });
    Ok(())
}

async fn broadcast_notice<B>(bot: &B, state: &AppState, from: ChatId, ids: Vec<MessageId>)
where
    B: Requester + Send + Sync,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::CopyMessage: Send,
    B::CopyMessages: Send,
{
    if ids.is_empty() {
        return;
    }
    let markup = if ids.len() == 1 {
        build_notice_keyboard(state)
    } else {
        None
    };
    if ids.len() == 1 && markup.is_none() && state.notice_url.is_some() {
        warn!("공지 링크가 올바른 주소가 아니라 버튼 없이 전달합니다.");
    }

    let mut copies: Vec<Vec<(ChatId, MessageId)>> = vec![Vec::new(); ids.len()];
    for chat_id in state.group_chat_ids() {
        let mut target = chat_id;
        let mut result = copy_notice(bot, target, from, &ids, markup.clone()).await;
        if let Err(err) = &result {
            match notice_failure(request_error(err)) {
                NoticeFailure::Gone => {
                    warn!("공지 대상에서 제외합니다 (chat {:?}): {}", chat_id, err);
                    state.forget_group_chat(chat_id, None).await;
                    continue;
                }
                NoticeFailure::Moved(new_id) => {
                    state.forget_group_chat(chat_id, Some(new_id)).await;
                    target = new_id;
                    result = copy_notice(bot, target, from, &ids, markup.clone()).await;
                }
                NoticeFailure::Other => {}
            }
        }
        match result {
            Ok(sent) => {
                for (slot, copy) in copies.iter_mut().zip(sent) {
                    slot.push((target, copy));
                }
            }
            Err(err) => warn!("공지 전달 실패 (chat {:?}): {}", target, err),
        }
    }

    let button = markup.is_some();
    for (source, copies) in ids.into_iter().zip(copies) {
        state
            .notices
            .remember(source, NoticeCopies { button, copies });
    }
}

async fn copy_notice<B>(
    bot: &B,
    chat_id: ChatId,
    from: ChatId,
    ids: &[MessageId],
    markup: Option<InlineKeyboardMarkup>,
) -> Result<Vec<MessageId>, B::Err>
where
    B: Requester + Send + Sync,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::CopyMessage: Send,
    B::CopyMessages: Send,
{
    let send = || async {
        match ids {
            [id] => {
                let mut request = bot.copy_message(chat_id, from, *id);
                if let Some(markup) = markup.clone() {
                    request = request.reply_markup(markup);
                }
                request.await.map(|copied| vec![copied])
            }
            _ => bot.copy_messages(chat_id, from, ids.iter().copied()).await,
        }
    };
    match send().await {
        Err(err) => match retry_after(request_error(&err)) {
            Some(wait) => {
                tokio::time::sleep(wait).await;
                send().await
            }
            None => Err(err),
        },
        sent => sent,
    }
}

pub(crate) async fn handle_notice_edit<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::EditMessageText: Send,
    B::EditMessageCaption: Send,
{
    if state.notice_chat_id != Some(msg.chat.id) {
        return Ok(());
    }
    let _turn = state.notices.turn.lock().await;
    let Some(record) = state.notices.copies_of(msg.id) else {
        return Ok(());
    };
    let markup = if record.button {
        build_notice_keyboard(&state)
    } else {
        None
    };

    for (chat_id, copy_id) in record.copies {
        let result = match msg.text() {
            Some(text) => {
                let mut request = bot.edit_message_text(chat_id, copy_id, text);
                if let Some(entities) = msg.entities() {
                    request = request.entities(entities.to_vec());
                }
                if let Some(markup) = markup.clone() {
                    request = request.reply_markup(markup);
                }
                request.await.map(|_| ())
            }
            None => {
                let mut request = bot.edit_message_caption(chat_id, copy_id);
                if let Some(caption) = msg.caption() {
                    request = request.caption(caption);
                }
                if let Some(entities) = msg.caption_entities() {
                    request = request.caption_entities(entities.to_vec());
                }
                if let Some(markup) = markup.clone() {
                    request = request.reply_markup(markup);
                }
                request.await.map(|_| ())
            }
        };
        if let Err(err) = result {
            warn!("공지 수정 반영 실패 (chat {:?}): {}", chat_id, err);
        }
    }
    Ok(())
}

pub(super) fn build_notice_keyboard(state: &AppState) -> Option<InlineKeyboardMarkup> {
    let url = Url::parse(state.notice_url.as_deref()?).ok()?;
    Some(InlineKeyboardMarkup::new(vec![vec![
        InlineKeyboardButton::url("공지방 참여하기", url),
    ]]))
}
