use anyhow::Result;
use log::{error, warn};
use teloxide::prelude::*;
use teloxide::types::{
    CallbackQuery, ChatId, ChatKind, InlineKeyboardButton, InlineKeyboardMarkup, InputFile,
    ParseMode, UserId,
};
use teloxide::utils::html;
use url::Url;

use super::super::gallery::{
    build_gallery_keyboard, build_gallery_preparing_keyboard, build_share_ready_keyboard,
    download_action_button, fetch_action_button, preparing_action_button, render_gallery_message,
    replace_gallery_action_button,
};
use super::super::{AppState, HandlerResult};

pub(crate) async fn handle_callback<B>(
    bot: B,
    query: CallbackQuery,
    state: AppState,
) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::EditMessageText: Send,
    B::EditMessageReplyMarkup: Send,
    B::SendDocument: Send,
{
    let Some(data) = query.data.clone() else {
        bot.answer_callback_query(query.id).await?;
        return Ok(());
    };

    if let Some(gallery_id) = data.strip_prefix("fetch_") {
        handle_fetch_callback(&bot, &query, &state, gallery_id).await?;
        return Ok(());
    }

    if data.starts_with("prep_") {
        let _ = bot
            .answer_callback_query(query.id)
            .text("대기 중.\n선생님.\n뷰어를 준비합니다.")
            .await;
        return Ok(());
    }

    if let Some(token) = data.strip_prefix("dl_") {
        handle_download_callback(&bot, &query, &state, token).await?;
        return Ok(());
    }

    if let Some(gallery_id) = data.strip_prefix("save_") {
        let info = match state.gallery_client.get_gallery_info(gallery_id).await {
            Ok(info) => info,
            Err(err) => {
                error!("갤러리 조회 실패 (callback, ID {}): {}", gallery_id, err);
                let _ = bot
                    .answer_callback_query(query.id)
                    .text(
                        "오류.\n선생님.\n갤러리 정보를 불러오지 못했습니다.\n잠시 후 다시 시도해 주세요.",
                    )
                    .show_alert(true)
                    .await;
                return Ok(());
            }
        };

        match info {
            Some(info) => {
                let message = render_gallery_message(&info, true);
                let keyboard = build_gallery_keyboard(&info, false);

                let user = query.from.id;
                if let Err(err) = bot
                    .send_message(user, message)
                    .parse_mode(ParseMode::Html)
                    .reply_markup(keyboard)
                    .disable_notification(true)
                    .await
                {
                    error!(
                        "개인 메시지 전송 실패 (user {:?}, id {}): {}",
                        user, info.id, err
                    );

                    let _ = bot
                        .answer_callback_query(query.id)
                        .text("불가.\n선생님.\n개인 대화를 먼저 시작해 주세요.\n차단 해제가 필요합니다.")
                        .show_alert(true)
                        .await;
                } else {
                    let _ = bot
                        .answer_callback_query(query.id)
                        .text("전송 완료.\n선생님.\n개인 메시지로 전송했습니다.")
                        .await;
                }
            }
            None => {
                let _ = bot
                    .answer_callback_query(query.id)
                    .text("확인 불가.\n선생님.\n저장할 갤러리 정보를 찾지 못했습니다.")
                    .show_alert(true)
                    .await;
            }
        }
    } else {
        bot.answer_callback_query(query.id).await?;
    }

    Ok(())
}

pub(super) async fn handle_fetch_callback<B>(
    bot: &B,
    query: &CallbackQuery,
    state: &AppState,
    gallery_id: &str,
) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::EditMessageText: Send,
    B::EditMessageReplyMarkup: Send,
{
    let Some(msg) = query.regular_message() else {
        let _ = bot
            .answer_callback_query(query.id.clone())
            .text("불가.\n선생님.\n메시지를 찾지 못했습니다.")
            .show_alert(true)
            .await;
        return Ok(());
    };

    let _ = bot
        .answer_callback_query(query.id.clone())
        .text("대기 중.\n선생님.\n뷰어를 준비합니다.")
        .await;

    let private = matches!(msg.chat.kind, ChatKind::Private(_));
    let include_save = !private;
    let fallback_info = crate::hitomi::GalleryInfo {
        id: gallery_id.to_string(),
        title: String::new(),
        artists: String::new(),
        language: String::new(),
        tags: vec![],
    };
    let original_markup = msg.reply_markup().cloned();
    let waiting_keyboard = original_markup
        .as_ref()
        .map(|markup| replace_gallery_action_button(markup, preparing_action_button(gallery_id)))
        .unwrap_or_else(|| build_gallery_preparing_keyboard(&fallback_info, include_save));
    if let Err(err) = bot
        .edit_message_reply_markup(msg.chat.id, msg.id)
        .reply_markup(waiting_keyboard)
        .await
    {
        warn!("뷰어 준비 키보드 수정 실패 (id {}): {}", gallery_id, err);
    }

    let bot = bot.clone();
    let state = state.clone();
    let gallery_id = gallery_id.to_string();
    let chat_id = msg.chat.id;
    let message_id = msg.id;

    tokio::spawn(async move {
        match crate::hiromi_share::share_gallery(&state.hiromi_bin, &gallery_id).await {
            Ok(claim) => {
                let info = match state.gallery_client.get_gallery_info(&gallery_id).await {
                    Ok(Some(info)) => info,
                    _ => crate::hitomi::GalleryInfo {
                        id: gallery_id.clone(),
                        title: claim.title.clone(),
                        artists: "정보 없음".to_string(),
                        language: "정보 없음".to_string(),
                        tags: vec![],
                    },
                };
                let keyboard = original_markup
                    .as_ref()
                    .map(|markup| {
                        replace_gallery_action_button(markup, download_action_button(&claim.token))
                    })
                    .unwrap_or_else(|| {
                        build_share_ready_keyboard(&info, &claim.token, include_save)
                    });
                state.put_share_claim(claim.clone());
                if let Err(err) = bot
                    .edit_message_reply_markup(chat_id, message_id)
                    .reply_markup(keyboard)
                    .await
                {
                    error!(
                        "뷰어 준비 완료 키보드 수정 실패 (id {}): {}",
                        gallery_id, err
                    );
                }
            }
            Err(err) => {
                error!("hiromi share 실패 (id {}): {}", gallery_id, err);
                let busy = err.to_string().contains("already running")
                    || err.to_string().contains("job already running");
                if !busy {
                    let keyboard = original_markup
                        .as_ref()
                        .map(|markup| {
                            replace_gallery_action_button(markup, fetch_action_button(&gallery_id))
                        })
                        .unwrap_or_else(|| build_gallery_keyboard(&fallback_info, include_save));
                    let _ = bot
                        .edit_message_reply_markup(chat_id, message_id)
                        .reply_markup(keyboard)
                        .await;
                }
            }
        }
    });

    Ok(())
}

#[allow(clippy::collapsible_if)]
pub(super) async fn handle_download_callback<B>(
    bot: &B,
    query: &CallbackQuery,
    state: &AppState,
    token: &str,
) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendDocument: Send,
{
    match deliver_share_claim(bot, state, ChatId(query.from.id.0 as i64), token, false).await {
        Ok(true) => {
            let _ = bot
                .answer_callback_query(query.id.clone())
                .text("전송 완료.\n선생님.\n개인 메시지로 전송했습니다.")
                .await;
        }
        Ok(false) => {
            let _ = bot
                .answer_callback_query(query.id.clone())
                .text("확인 불가.\n선생님.\n다운로드 정보를 찾지 못했습니다.")
                .show_alert(true)
                .await;
        }
        Err(err) => {
            error!("뷰어 개인 메시지 전송 실패: {}", err);
            let _ = bot
                .answer_callback_query(query.id.clone())
                .text("불가.\n선생님.\n개인 대화를 먼저 시작해 주세요.\n차단 해제가 필요합니다.")
                .show_alert(true)
                .await;
            if !state.bot_username.is_empty() {
                if let Some(msg) = query.regular_message() {
                    let url = format!("https://t.me/{}?start=dl_{}", state.bot_username, token);
                    if let Ok(parsed) = Url::parse(&url) {
                        let keyboard =
                            InlineKeyboardMarkup::new(vec![vec![InlineKeyboardButton::url(
                                "봇 열기",
                                parsed,
                            )]]);
                        let _ = bot
                            .send_message(
                                msg.chat.id,
                                "불가.\n선생님.\n개인 대화를 먼저 시작해 주세요.",
                            )
                            .reply_markup(keyboard)
                            .await;
                    }
                }
            }
        }
    }
    Ok(())
}

pub(super) async fn deliver_share_claim<B>(
    bot: &B,
    state: &AppState,
    chat_id: ChatId,
    token: &str,
    notify_missing: bool,
) -> Result<bool>
where
    B: Requester + Send + Sync,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendDocument: Send,
{
    let Some(claim) = state.get_share_claim(token) else {
        if notify_missing {
            send_in_chat_plain(
                bot,
                chat_id,
                "확인 불가.\n선생님.\n유효하지 않은 다운로드 요청입니다.",
            )
            .await?;
        }
        return Ok(false);
    };
    if !claim.path.is_empty() && !std::path::Path::new(&claim.path).is_file() {
        if notify_missing {
            send_in_chat_plain(
                bot,
                chat_id,
                "확인 불가.\n선생님.\n뷰어 파일을 찾지 못했습니다.",
            )
            .await?;
        }
        return Ok(false);
    }
    send_share_claim_message(bot, UserId(chat_id.0 as u64), &claim).await?;
    Ok(true)
}

pub(super) async fn send_share_claim_message<B>(
    bot: &B,
    user_id: UserId,
    claim: &crate::hiromi_share::ShareClaim,
) -> Result<()>
where
    B: Requester + Send + Sync,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendDocument: Send,
{
    if !claim.path.is_empty() {
        let title = html::escape(&claim.title);
        let caption = format!(
            "전송 완료.\n선생님.\n<b>제목:</b> {title}\n{pages}쪽",
            pages = claim.pages
        );
        let file_name = format!("{}.html", claim.gallery_id);
        let document = InputFile::file(claim.path.clone()).file_name(file_name);
        bot.send_document(user_id, document)
            .caption(caption)
            .parse_mode(ParseMode::Html)
            .disable_notification(true)
            .await?;
        return Ok(());
    }
    let title = html::escape(&claim.title);
    let url = html::escape(&claim.url);
    let text = format!(
        "전송 완료.\n선생님.\n<b>제목:</b> {title}\n{pages}쪽\n{url}",
        pages = claim.pages
    );
    let mut request = bot
        .send_message(user_id, text)
        .parse_mode(ParseMode::Html)
        .disable_notification(true);
    if let Ok(parsed) = Url::parse(&claim.url) {
        request = request.reply_markup(InlineKeyboardMarkup::new(vec![vec![
            InlineKeyboardButton::url("브라우저에서 열기", parsed),
        ]]));
    }
    request.await?;
    Ok(())
}

pub(super) async fn send_in_chat_plain<B>(bot: &B, chat_id: ChatId, text: &str) -> Result<()>
where
    B: Requester + Send + Sync,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    bot.send_message(chat_id, text).await?;
    Ok(())
}
