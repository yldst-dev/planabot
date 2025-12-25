use std::time::Instant;

use log::error;
use teloxide::prelude::*;
use teloxide::types::{CallbackQuery, ChatAction, Message, ParseMode};
use teloxide::utils::html;
use tokio::time::{self, Duration};

use crate::planabrain;

use super::commands::Command;
use super::gallery::{
    build_gallery_keyboard, extract_gallery_id, is_private_chat, render_gallery_message,
};
use super::telegram::{send_reply_with_fallback, SendOptions};
use super::{AppState, HandlerResult};

pub(crate) async fn handle_command<B>(bot: B, msg: Message, cmd: Command, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    match cmd {
        Command::Start => {
            let mut text = String::from(
                "선생님, 반갑습니다. 저는 선생님의 Hitomi.la 갤러리 정보 검색 요청을 지원하는 Bot, 프라나입니다.\n\n명령어 프로토콜 안내\n- 개인 채널: 숫자 ID 직접 입력 (예시: 12345)\n- 모든 채널: 접두사 !와 ID 입력 (예시: !12345)\n",
            );

            if state.bot_username.is_empty() {
                text.push_str("- 그룹 채널: 저를 호출 후 ID 입력 (예시: @봇이름 12345)\n");
            } else {
                text.push_str(&format!(
                    "- 그룹 채널: 저를 호출(@{}) 후 ID 입력 (예시: @{} 12345)\n",
                    state.bot_username, state.bot_username
                ));
            }

            text.push_str("\n분석이 필요한 ID를 입력해주십시오, 선생님.");

            bot.send_message(msg.chat.id, html::escape(&text))
                .parse_mode(ParseMode::Html)
                .await?;
        }
        Command::Ping => {
            let started = Instant::now();
            let elapsed = started.elapsed();
            let ms = elapsed.as_secs_f64() * 1000.0;

            bot.send_message(
                msg.chat.id,
                format!("Pong..? 입니다, 선생님.\n{:.6} ms", ms),
            )
            .await?;
        }
        Command::MemoryReset => {
            let Some(user) = msg.from.as_ref() else {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "선생님, 사용자 정보를 확인할 수 없습니다.",
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
                        "선생님, 메모리를 초기화했습니다. 새 대화를 시작할 수 있습니다.",
                        SendOptions::default(),
                    )
                    .await?;
                }
                Ok(false) => {
                    send_reply_with_fallback(
                        &bot,
                        &msg,
                        "선생님, 초기화할 메모리가 없습니다.",
                        SendOptions::default(),
                    )
                    .await?;
                }
                Err(err) => {
                    error!("메모리 초기화 실패: {}", err);
                    send_reply_with_fallback(
                        &bot,
                        &msg,
                        "선생님, 메모리 초기화에 실패했습니다. 잠시 후 다시 시도해 주십시오.",
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
    let Some(text) = msg.text() else {
        return Ok(());
    };

    let question = match planabrain::extract_plana_question(text) {
        Some(q) => q,
        None if state.is_reply_to_planabrain(&msg) => text.trim().to_string(),
        None => return Ok(()),
    };

    if msg.from.as_ref().map(|user| user.is_bot).unwrap_or(false) {
        return Ok(());
    }

    let question = question.trim().to_string();
    if question.is_empty() {
        let sent = send_reply_with_fallback(
            &bot,
            &msg,
            "선생님, 질문을 말씀해 주십시오.",
            SendOptions::default(),
        )
        .await?;
        state.record_planabrain_reply(&sent);
        return Ok(());
    }

    let user_id = msg
        .from
        .as_ref()
        .map(|user| user.id.to_string())
        .unwrap_or_else(|| "unknown".to_string());

    let mut typing_interval = time::interval(Duration::from_secs(4));
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
            let sent =
                send_reply_with_fallback(&bot, &msg, reply, SendOptions::default()).await?;
            state.record_planabrain_reply(&sent);
        }
        Err(err) => {
            error!("planabrain 응답 실패: {}", err);
            let sent = send_reply_with_fallback(
                &bot,
                &msg,
                "선생님, 응답 생성에 실패했습니다. 잠시 후 다시 시도해 주십시오.",
                SendOptions::default(),
            )
            .await?;
            state.record_planabrain_reply(&sent);
        }
    }

    Ok(())
}

pub(crate) async fn handle_message<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let text = match msg.text() {
        Some(t) => t.trim(),
        None => return Ok(()),
    };

    let Some(gallery_id) = extract_gallery_id(text, &msg, &state.bot_username) else {
        return Ok(());
    };

    let chat_id = msg.chat.id;
    let initial = send_reply_with_fallback(
        &bot,
        &msg,
        format!(
            "선생님, 요청하신 ID {}에 대한 데이터 검색을 시작합니다. 잠시만 기다려주십시오...",
            gallery_id
        ),
        SendOptions {
            disable_notification: Some(true),
            ..SendOptions::default()
        },
    )
    .await?;

    let info = state.gallery_client.get_gallery_info(&gallery_id).await?;

    match info {
        Some(info) => {
            let response = render_gallery_message(&info, false);
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
                "선생님, ID {}에 대한 정보를 찾을 수 없거나, 제목 데이터가 누락된 것으로 확인됩니다.",
                gallery_id
            );

            if let Err(err) = bot.edit_message_text(chat_id, initial.id, error_text).await {
                error!("오류 메시지 수정 실패 (ID {}): {}", gallery_id, err);
            }
        }
    }

    Ok(())
}

pub(crate) async fn handle_callback<B>(bot: B, query: CallbackQuery, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let Some(data) = query.data.clone() else {
        bot.answer_callback_query(query.id).await?;
        return Ok(());
    };

    if let Some(gallery_id) = data.strip_prefix("save_") {
        let info = state.gallery_client.get_gallery_info(gallery_id).await?;

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
                        .text("선생님, 먼저 저와 개인 대화를 시작하거나 차단을 해제해 주세요.")
                        .show_alert(true)
                        .await;
                } else {
                    let _ = bot
                        .answer_callback_query(query.id)
                        .text("갤러리 정보가 저와 선생님의 메시지로 전송되었습니다.")
                        .await;
                }
            }
            None => {
                let _ = bot
                    .answer_callback_query(query.id)
                    .text("저장할 갤러리 정보를 찾지 못했습니다.")
                    .show_alert(true)
                    .await;
            }
        }
    } else {
        bot.answer_callback_query(query.id).await?;
    }

    Ok(())
}

pub(crate) fn is_plana_trigger(msg: &Message, state: &AppState) -> bool {
    if !state.is_after_boot(msg) {
        return false;
    }

    let text = msg.text().unwrap_or("");
    if !text.trim().is_empty() && planabrain::extract_plana_question(text).is_some() {
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
