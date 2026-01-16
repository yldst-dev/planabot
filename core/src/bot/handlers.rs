use std::time::Instant;

use chrono::{Datelike, FixedOffset, Timelike, Weekday};
use log::{error, warn};
use teloxide::prelude::*;
use teloxide::types::{
    CallbackQuery, ChatAction, InlineKeyboardButton, InlineKeyboardMarkup, Message, ParseMode,
};
use teloxide::utils::html;
use tokio::time::{self, Duration};
use url::Url;

use crate::planabrain;
use crate::time::kst_now;

use super::commands::Command;
use super::gallery::{
    GalleryIdSource, build_gallery_keyboard, extract_gallery_id, is_private_chat,
    render_gallery_message, render_gallery_message_for_user,
};
use super::telegram::{SendOptions, send_reply_with_fallback};
use super::{AppState, HandlerResult};

pub(crate) async fn handle_command<B>(
    bot: B,
    msg: Message,
    cmd: Command,
    state: AppState,
) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    if cmd != Command::Ping && !state.is_after_boot(&msg) {
        return Ok(());
    }

    state.record_group_chat(&msg).await;

    match cmd {
        Command::Start => {
            let mut text = String::from(
                "접속 완료.\n선생님.\n기능을 준비했습니다.\n갤러리 검색과 링크 정리를 지원합니다.\nAI 채팅은 베타입니다.\n개인 채팅은 숫자 ID만 가능합니다.",
            );

            if state.bot_username.is_empty() {
                text.push_str("\n그룹에서는 호출 후 ID를 입력합니다.");
            } else {
                text.push_str(&format!(
                    "\n그룹에서는 @{} 뒤에 ID를 입력합니다.",
                    state.bot_username
                ));
            }

            text.push_str("\nID를 입력해 주세요.");

            let _ = send_reply_with_fallback(
                &bot,
                &msg,
                html::escape(&text),
                SendOptions {
                    reply_markup: build_notice_keyboard(&state),
                    ..SendOptions::default()
                },
            )
            .await?;
        }
        Command::Ping => {
            let started = Instant::now();
            let elapsed = started.elapsed();
            let ms = elapsed.as_secs_f64() * 1000.0;

            bot.send_message(msg.chat.id, format!("응답 확인.\n선생님.\n{:.6} ms", ms))
                .await?;
        }
        Command::MemoryReset => {
            let Some(user) = msg.from.as_ref() else {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "확인 불가.\n선생님.\n사용자 정보를 확인하지 못했습니다.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            };

            match planabrain::reset_user_memory(&user.id.to_string()).await {
                Ok(true) => {
                    send_reply_with_fallback(
                        &bot,
                        &msg,
                        "완료.\n선생님.\n메모리를 초기화했습니다.\n새 대화를 시작할 수 있습니다.",
                        SendOptions::default(),
                    )
                    .await?;
                }
                Ok(false) => {
                    send_reply_with_fallback(
                        &bot,
                        &msg,
                        "확인 완료.\n선생님.\n초기화할 메모리가 없습니다.",
                        SendOptions::default(),
                    )
                    .await?;
                }
                Err(err) => {
                    error!("메모리 초기화 실패: {}", err);
                    send_reply_with_fallback(
                        &bot,
                        &msg,
                        "오류.\n선생님.\n메모리 초기화에 실패했습니다.\n잠시 후 다시 시도해 주세요.",
                        SendOptions::default(),
                    )
                    .await?;
                }
            }
        }
    }

    Ok(())
}

pub(crate) async fn handle_plana_message<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendChatAction: Send,
{
    if !state.is_after_boot(&msg) {
        return Ok(());
    }

    state.record_group_chat(&msg).await;

    let Some(text) = extract_message_text(&msg) else {
        return Ok(());
    };

    let question = match planabrain::extract_plana_question(&text) {
        Some(q) => q,
        None if state.is_reply_to_planabrain(&msg) => text.trim().to_string(),
        None => return Ok(()),
    };

    if msg.from.as_ref().map(|user| user.is_bot).unwrap_or(false) {
        return Ok(());
    }

    let user_id = msg
        .from
        .as_ref()
        .and_then(|user| i64::try_from(user.id.0).ok());
    let is_private = msg.chat.is_private();
    if !planabrain::is_planabrain_allowed(msg.chat.id.0, user_id, is_private) {
        send_reply_with_fallback(
            &bot,
            &msg,
            "접근 불가.\n선생님.\n프라나 AI 기능은 베타입니다.\n허용된 채팅만 지원합니다.",
            SendOptions::default(),
        )
        .await?;
        return Ok(());
    }

    let question = question.trim().to_string();
    let question = build_planabrain_question(&question, &msg);
    if question.trim().is_empty() {
        let sent = send_reply_with_fallback(
            &bot,
            &msg,
            "대기 중.\n선생님.\n질문을 입력해 주세요.",
            SendOptions::default(),
        )
        .await?;
        state.record_planabrain_reply(&sent).await;
        return Ok(());
    }

    let user_id = msg
        .from
        .as_ref()
        .map(|user| user.id.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let now = kst_now().await;
    let question = format_question_with_timestamp(&question, now);
    send_typing_in_thread(&bot, &msg).await;
    let mut typing_interval = time::interval(Duration::from_secs(3));
    let ask_fut = planabrain::run_planabrain_ask(&question, &user_id);
    tokio::pin!(ask_fut);

    let answer = loop {
        tokio::select! {
            _ = typing_interval.tick() => {
                send_typing_in_thread(&bot, &msg).await;
            }
            result = &mut ask_fut => {
                break result;
            }
        }
    };

    match answer {
        Ok(answer) => {
            let reply = planabrain::truncate_message(answer.trim(), 4000);
            let sent = send_reply_with_fallback(&bot, &msg, reply, SendOptions::default()).await?;
            state.record_planabrain_reply(&sent).await;
        }
        Err(err) => {
            error!("planabrain 응답 실패: {}", err);
            let sent = send_reply_with_fallback(
                &bot,
                &msg,
                "오류.\n선생님.\n응답 생성에 실패했습니다.\n잠시 후 다시 시도해 주세요.",
                SendOptions::default(),
            )
            .await?;
            state.record_planabrain_reply(&sent).await;
        }
    }

    Ok(())
}

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

pub(crate) async fn handle_callback<B>(
    bot: B,
    query: CallbackQuery,
    state: AppState,
) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let Some(data) = query.data.clone() else {
        bot.answer_callback_query(query.id).await?;
        return Ok(());
    };

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

fn build_notice_keyboard(state: &AppState) -> Option<InlineKeyboardMarkup> {
    let url = Url::parse(state.notice_url.as_deref()?).ok()?;
    Some(InlineKeyboardMarkup::new(vec![vec![
        InlineKeyboardButton::url("공지방 참여하기", url),
    ]]))
}

pub(crate) fn is_plana_trigger(msg: &Message, state: &AppState) -> bool {
    if !state.is_after_boot(msg) {
        return false;
    }

    let text = extract_message_text(msg).unwrap_or_default();
    if !text.trim().is_empty() && planabrain::extract_plana_question(&text).is_some() {
        return true;
    }

    if text.trim().is_empty() {
        return false;
    }

    state.is_reply_to_planabrain(msg)
}

async fn send_typing_in_thread<B>(bot: &B, msg: &Message)
where
    B: Requester + ?Sized,
    B::SendChatAction: Send,
{
    let mut req = bot.send_chat_action(msg.chat.id, ChatAction::Typing);
    if let Some(thread_id) = msg.thread_id {
        req = req.message_thread_id(thread_id);
    }
    let _ = req.await;
}

fn format_question_with_timestamp(question: &str, now: chrono::DateTime<FixedOffset>) -> String {
    let weekday = match now.weekday() {
        Weekday::Mon => "월",
        Weekday::Tue => "화",
        Weekday::Wed => "수",
        Weekday::Thu => "목",
        Weekday::Fri => "금",
        Weekday::Sat => "토",
        Weekday::Sun => "일",
    };
    let timestamp = format!(
        "{:04}-{:02}-{:02} ({}) {:02}:{:02}:{:02}",
        now.year(),
        now.month(),
        now.day(),
        weekday,
        now.hour(),
        now.minute(),
        now.second()
    );
    format!("현재 시각: {}\n\n{}", timestamp, question)
}

fn extract_message_text(msg: &Message) -> Option<String> {
    msg.text()
        .map(|text| text.to_string())
        .or_else(|| msg.caption().map(|caption| caption.to_string()))
}

fn extract_reply_text(msg: &Message) -> Option<String> {
    let reply = msg.reply_to_message()?;
    if reply.from.as_ref().map(|user| user.is_bot).unwrap_or(false) {
        return None;
    }
    reply
        .text()
        .map(|text| text.to_string())
        .or_else(|| reply.caption().map(|caption| caption.to_string()))
        .and_then(|text| {
            let trimmed = text.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
}

fn build_planabrain_question(question: &str, msg: &Message) -> String {
    let question = question.trim();
    let Some(context) = extract_reply_text(msg) else {
        return question.to_string();
    };
    if question.is_empty() {
        return format!("참고 메시지:\n{}", context);
    }
    format!("참고 메시지:\n{}\n\n질문:\n{}", context, question)
}
