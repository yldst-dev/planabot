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
        Command::Memory => {
            let reply = match memory_user(&msg) {
                Err(reply) => reply.to_string(),
                Ok(user_id) => match planabrain::list_memories(&user_id, msg.chat.id.0).await {
                    Ok(memories) => render_memory_list(&memories),
                    Err(err) => {
                        error!("기억 목록 조회 실패: {}", err);
                        "오류.\n선생님.\n기억 목록을 불러오지 못했습니다.".to_string()
                    }
                },
            };
            send_reply_with_fallback(&bot, &msg, reply, SendOptions::default()).await?;
        }
        Command::Forget => {
            let memory_id = msg
                .text()
                .and_then(|text| text.split_whitespace().nth(1))
                .and_then(|raw| raw.trim_start_matches('#').parse::<i64>().ok())
                .filter(|id| *id > 0);
            let reply = match (memory_user(&msg), memory_id) {
                (Err(reply), _) => reply,
                (Ok(_), None) => {
                    "확인 불가.\n선생님.\n삭제할 기억 번호가 필요합니다.\n예: /forget 12"
                }
                (Ok(user_id), Some(memory_id)) => {
                    match planabrain::forget_memory(&user_id, msg.chat.id.0, memory_id).await {
                        Ok(true) => "삭제 완료.\n선생님.\n해당 기억을 지웠습니다.",
                        Ok(false) => {
                            "확인 불가.\n선생님.\n이 대화방에서 지울 수 있는 기억이 아닙니다."
                        }
                        Err(err) => {
                            error!("기억 삭제 실패: {}", err);
                            "오류.\n선생님.\n기억을 지우지 못했습니다."
                        }
                    }
                }
            };
            send_reply_with_fallback(&bot, &msg, reply, SendOptions::default()).await?;
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

fn memory_user(msg: &Message) -> Result<String, &'static str> {
    if !planabrain::is_planabrain_enabled() {
        return Err("불가.\n선생님.\n프라나브레인 기능이 비활성화 상태입니다.");
    }
    msg.from
        .as_ref()
        .map(|user| user.id.to_string())
        .ok_or("확인 불가.\n선생님.\n사용자 정보를 확인하지 못했습니다.")
}

fn render_memory_list(memories: &[planabrain::MemoryItem]) -> String {
    const MAX_LISTED: usize = 40;
    if memories.is_empty() {
        return "확인 완료.\n선생님.\n이 대화방에서 저장된 기억이 없습니다.".to_string();
    }
    let mut lines = vec!["기억 목록.".to_string(), "선생님.".to_string()];
    for memory in memories.iter().take(MAX_LISTED) {
        let label = if memory.kind == "room" {
            " [대화방]"
        } else {
            ""
        };
        lines.push(format!("#{}{} {}", memory.id, label, memory.content));
    }
    if memories.len() > MAX_LISTED {
        lines.push(format!("외 {}건.", memories.len() - MAX_LISTED));
    }
    lines.push("삭제: /forget 번호".to_string());
    lines.join("\n")
}

#[cfg(test)]
mod memory_list_tests {
    use super::render_memory_list;
    use crate::planabrain::MemoryItem;

    fn item(id: i64, kind: &str, content: &str) -> MemoryItem {
        MemoryItem {
            id,
            kind: kind.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn empty_memory_list_uses_status_line() {
        assert!(render_memory_list(&[]).starts_with("확인 완료.\n선생님.\n"));
    }

    #[test]
    fn memory_list_shows_ids_room_label_and_overflow() {
        let mut memories = vec![
            item(12, "fact", "사용자는 부산에 산다"),
            item(13, "room", "이 방은 금요일마다 회의한다"),
        ];
        memories.extend((0..40).map(|index| item(100 + index, "fact", "기억")));
        let rendered = render_memory_list(&memories);
        assert!(
            rendered
                .starts_with("기억 목록.\n선생님.\n#12 사용자는 부산에 산다\n#13 [대화방] 이 방은")
        );
        assert!(rendered.contains("외 2건."));
        assert!(rendered.ends_with("삭제: /forget 번호"));
    }
}
