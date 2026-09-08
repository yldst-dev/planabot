use std::time::Instant;

use log::error;
use teloxide::prelude::*;
use teloxide::types::{InputFile, Message, ParseMode};
use teloxide::utils::html;

use super::super::commands::Command;
use super::super::telegram::{SendOptions, send_reply_with_fallback};
use super::super::{AppState, HandlerResult};
use super::callback::*;
use super::message::*;
use super::plana::*;
use super::schedule::*;
use crate::schedule::render_schedule_list;
use crate::{planabrain, token};

pub(super) static DONATION_QR: &[u8] = include_bytes!("../assets/donation_qr.png");

pub(super) const DONATION_CAPTION: &str = "선생님. 후원을 해 주시려는 것인가요.\n선생님의 따뜻한 마음에 감동했습니다.\n\n후원 방식은 USDT를 통해 하실 수 있습니다.\n아래에 주소를 보내드리겠습니다. 네트워크는 TRC20 이니, 헷갈리지 않게 주의해 주세요.\n(선생님의 소매를 잡고 살짝 미소지으며 고개를 끄덕입니다.)\n\n<code>TFZuvEU4UjYYmMZont2EwVtZ61weqEFHD9</code>";

#[allow(clippy::collapsible_if)]
pub(crate) async fn handle_command<B>(
    bot: B,
    msg: Message,
    cmd: Command,
    state: AppState,
) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendDocument: Send,
{
    if !matches!(cmd, Command::Ping | Command::Version) && !state.is_after_boot(&msg) {
        return Ok(());
    }

    state.record_group_chat(&msg).await;

    match cmd {
        Command::Start => {
            if let Some(text) = msg.text() {
                if let Some(token) = crate::hiromi_share::start_share_token(text) {
                    deliver_share_claim(&bot, &state, msg.chat.id, token, true).await?;
                    return Ok(());
                }
            }

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
        Command::Version => {
            send_reply_with_fallback(
                &bot,
                &msg,
                format!(
                    "확인 완료.\n선생님.\n현재 실행 버전은 {} 입니다.",
                    env!("CARGO_PKG_VERSION")
                ),
                SendOptions::default(),
            )
            .await?;
        }
        Command::Token => {
            if !planabrain::is_planabrain_enabled() {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "불가.\n선생님.\n프라나브레인 기능이 비활성화 상태입니다.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            }

            let Some(reply) = msg.reply_to_message() else {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "불가.\n선생님.\n측정할 메시지에 답장한 뒤 /token을 입력해 주세요.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            };

            let Some(target_text) = extract_message_text(reply)
                .map(|text| text.trim().to_string())
                .filter(|text| !text.is_empty())
            else {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "불가.\n선생님.\n텍스트 또는 캡션 메시지만 측정할 수 있습니다.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            };

            match token::count_text_tokens(&target_text).await {
                Ok(result) => {
                    let limit = resolve_token_limit();
                    let report = render_token_report(result.total_tokens, limit);
                    send_reply_with_fallback(&bot, &msg, report, SendOptions::default()).await?;
                }
                Err(err) => {
                    error!("토큰 측정 실패: {}", err);
                    send_reply_with_fallback(
                        &bot,
                        &msg,
                        "오류.\n선생님.\n토큰 측정에 실패했습니다.\n모델 설정과 로컬 실행 환경을 확인해 주세요.",
                        SendOptions::default(),
                    )
                    .await?;
                }
            }
        }
        Command::MemoryReset => {
            if !planabrain::is_planabrain_enabled() {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "불가.\n선생님.\n프라나브레인 기능이 비활성화 상태입니다.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            }

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
        Command::Todo => {
            if !planabrain::is_planabrain_enabled() {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "불가.\n선생님.\n프라나브레인 기능이 비활성화 상태입니다.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            }

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

            let user_id_i64 = i64::try_from(user.id.0).ok();
            if !planabrain::is_planabrain_allowed(msg.chat.id.0, user_id_i64, msg.chat.is_private())
            {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "접근 불가.\n선생님.\n프라나브레인 기능은 베타입니다.\n허용된 채팅만 지원합니다.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            }

            match planabrain::list_user_todos(&user.id.to_string()).await {
                Ok(result) => {
                    let sent = send_reply_with_fallback(
                        &bot,
                        &msg,
                        result.markdown,
                        SendOptions::default(),
                    )
                    .await?;
                    state
                        .record_planabrain_reply_for_user(
                            &sent,
                            &format!("todo_{}", user.id.0),
                            user.id.0,
                        )
                        .await;
                }
                Err(err) => {
                    error!("todo 목록 조회 실패: {}", err);
                    send_reply_with_fallback(
                        &bot,
                        &msg,
                        "오류.\n선생님.\n할 일 목록을 확인하지 못했습니다.\n잠시 후 다시 시도해 주세요.",
                        SendOptions::default(),
                    )
                    .await?;
                }
            }
        }
        Command::Schedule => {
            handle_schedule_command(&bot, &msg, &state, "schedule").await?;
        }
        Command::Timer => {
            handle_schedule_command(&bot, &msg, &state, "timer").await?;
        }
        Command::GroupInfo => {
            if msg.chat.is_private() {
                send_reply_with_fallback(
                    &bot,
                    &msg,
                    "불가.\n선생님.\n이 명령은 그룹 채팅에서만 지원합니다.",
                    SendOptions::default(),
                )
                .await?;
                return Ok(());
            }

            send_reply_with_fallback(
                &bot,
                &msg,
                format!("확인 완료.\n선생님.\n그룹 ID: {}", msg.chat.id.0),
                SendOptions::default(),
            )
            .await?;
        }
        Command::Donation => {
            let photo = InputFile::memory(DONATION_QR).file_name("donation_qr.png");
            let mut request = bot
                .send_photo(msg.chat.id, photo)
                .caption(DONATION_CAPTION)
                .parse_mode(ParseMode::Html);
            if let Some(thread_id) = msg.thread_id {
                request = request.message_thread_id(thread_id);
            }
            request.await?;
        }
    }

    Ok(())
}

pub(super) async fn handle_schedule_command<B>(
    bot: &B,
    msg: &Message,
    state: &AppState,
    mode: &str,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    if !planabrain::is_planabrain_enabled() {
        send_reply_with_fallback(
            bot,
            msg,
            "불가.\n선생님.\n프라나브레인 기능이 비활성화 상태입니다.",
            SendOptions::default(),
        )
        .await?;
        return Ok(());
    }

    let Some(user) = msg.from.as_ref() else {
        send_reply_with_fallback(
            bot,
            msg,
            "확인 불가.\n선생님.\n사용자 정보를 확인하지 못했습니다.",
            SendOptions::default(),
        )
        .await?;
        return Ok(());
    };

    let user_id_i64 = i64::try_from(user.id.0).ok();
    if !planabrain::is_planabrain_allowed(msg.chat.id.0, user_id_i64, msg.chat.is_private()) {
        send_reply_with_fallback(
            bot,
            msg,
            "접근 불가.\n선생님.\n프라나브레인 기능은 베타입니다.\n허용된 채팅만 지원합니다.",
            SendOptions::default(),
        )
        .await?;
        return Ok(());
    }

    let payload = command_payload(msg, mode, &state.bot_username);
    if payload.trim().is_empty() {
        let items = state.schedule_store.list_user_pending(user.id.0);
        let sent = send_reply_with_fallback(
            bot,
            msg,
            render_schedule_list(&items),
            SendOptions::default(),
        )
        .await?;
        state
            .record_planabrain_reply_for_user(&sent, &format!("schedule_{}", user.id.0), user.id.0)
            .await;
        return Ok(());
    }

    let text = if mode == "timer" {
        format!("{payload} 타이머")
    } else {
        payload
    };
    let requester_user_id = Some(user.id.0);
    let handled = handle_schedule_interpretation(bot, msg, state, requester_user_id, &text).await?;
    if handled {
        return Ok(());
    }

    send_reply_with_fallback(
        bot,
        msg,
        "확인 불가.\n선생님.\n일정 내용을 해석하지 못했습니다.",
        SendOptions::default(),
    )
    .await?;
    Ok(())
}

pub(super) fn command_payload(msg: &Message, command: &str, bot_username: &str) -> String {
    let Some(text) = extract_message_text(msg) else {
        return String::new();
    };
    let trimmed = text.trim();
    let mut parts = trimmed.splitn(2, char::is_whitespace);
    let head = parts.next().unwrap_or_default();
    let rest = parts.next().unwrap_or_default().trim();
    let command_head = format!("/{command}");
    let command_with_bot = if bot_username.is_empty() {
        String::new()
    } else {
        format!("/{command}@{bot_username}")
    };
    if head.eq_ignore_ascii_case(&command_head)
        || (!command_with_bot.is_empty() && head.eq_ignore_ascii_case(&command_with_bot))
    {
        rest.to_string()
    } else {
        trimmed.to_string()
    }
}

pub(super) fn render_token_report(tokens: u32, limit: u32) -> String {
    if tokens > limit {
        let exceeded = tokens - limit;
        return format!(
            "주의.\n선생님.\n추정 토큰 {}.\n기준 {} 초과입니다.\n초과 {}.",
            tokens, limit, exceeded
        );
    }
    format!(
        "확인 완료.\n선생님.\n추정 토큰 {}.\n기준 {} 이하입니다.",
        tokens, limit
    )
}

pub(super) fn resolve_token_limit() -> u32 {
    std::env::var("PLANABOT_TOKEN_LIMIT")
        .ok()
        .and_then(|raw| raw.trim().parse::<u32>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(1024)
}
