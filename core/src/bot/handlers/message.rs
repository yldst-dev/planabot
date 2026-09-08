use log::{error, warn};
use teloxide::prelude::*;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup, Message, ParseMode};
use url::Url;

use super::super::gallery::{
    GalleryIdSource, build_gallery_keyboard, extract_gallery_id, is_private_chat,
    render_gallery_message, render_gallery_message_for_user,
};
use super::super::telegram::{SendOptions, send_reply_with_fallback};
use super::super::{AppState, HandlerResult};

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
            "검색 시작.\n선생님.\nID {} 조회 중입니다.\n잠시만 대기해 주세요.",
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
                    "오류.\n선생님.\n갤러리 정보를 불러오지 못했습니다.\n잠시 후 다시 시도해 주세요.",
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
{
    if !state.is_after_boot(&msg) {
        return Ok(());
    }

    let Some(notice_chat_id) = state.notice_chat_id else {
        return Ok(());
    };

    if msg.chat.id != notice_chat_id {
        return Ok(());
    }

    let Some(markup) = build_notice_keyboard(&state) else {
        return Ok(());
    };

    let targets = state.group_chat_ids();
    if targets.is_empty() {
        return Ok(());
    }

    for chat_id in targets {
        let mut request = bot.copy_message(chat_id, msg.chat.id, msg.id);
        request = request.reply_markup(markup.clone());

        if let Err(err) = request.await {
            warn!("공지 전달 실패 (chat {:?}): {}", chat_id, err);
        }
    }

    Ok(())
}

pub(crate) async fn handle_notice_edit<B>(_bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    if !state.is_after_boot(&msg) {
        return Ok(());
    }

    let Some(notice_chat_id) = state.notice_chat_id else {
        return Ok(());
    };

    if msg.chat.id != notice_chat_id {
        return Ok(());
    }

    Ok(())
}

pub(super) fn build_notice_keyboard(state: &AppState) -> Option<InlineKeyboardMarkup> {
    let url = Url::parse(state.notice_url.as_deref()?).ok()?;
    Some(InlineKeyboardMarkup::new(vec![vec![
        InlineKeyboardButton::url("공지방 참여하기", url),
    ]]))
}
