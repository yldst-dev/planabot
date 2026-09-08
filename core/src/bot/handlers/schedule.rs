use anyhow::Result;
use log::warn;
use teloxide::prelude::*;
use teloxide::types::Message;

use super::super::AppState;
use super::super::telegram::{SendOptions, send_reply_with_fallback};
use crate::planabrain;
use crate::schedule::{
    NewSchedule, ScheduleKind, ScheduleMutation, render_schedule_add_result,
    render_schedule_cancel_result, render_schedule_list,
};

pub(super) async fn handle_schedule_interpretation<B>(
    bot: &B,
    msg: &Message,
    state: &AppState,
    requester_user_id: Option<u64>,
    text: &str,
) -> Result<bool, anyhow::Error>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let schedule = match planabrain::interpret_schedule_request(text).await {
        Ok(schedule) => schedule,
        Err(err) => {
            warn!("일정 자연어 처리 실패: {}", err);
            return Ok(false);
        }
    };
    apply_schedule_interpretation(bot, msg, state, requester_user_id, schedule).await
}

pub(super) async fn apply_schedule_interpretation<B>(
    bot: &B,
    msg: &Message,
    state: &AppState,
    requester_user_id: Option<u64>,
    schedule: planabrain::ScheduleInterpretOutput,
) -> Result<bool, anyhow::Error>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let Some(owner_user_id) = requester_user_id else {
        return Ok(false);
    };
    if !schedule.handled {
        return Ok(false);
    }

    let message = match schedule.action.as_str() {
        "list" => {
            let items = state.schedule_store.list_user_pending(owner_user_id);
            render_schedule_list(&items)
        }
        "cancel" => {
            let target = schedule.target.unwrap_or_default();
            let result = state.schedule_store.cancel(owner_user_id, &target).await?;
            render_schedule_cancel_result(&result)
        }
        "add" => {
            if let Some(error) = schedule.error.as_deref() {
                let result = ScheduleMutation {
                    ok: false,
                    item: None,
                    items: state.schedule_store.list_user_pending(owner_user_id),
                    error: Some(error.to_string()),
                };
                render_schedule_add_result(&result)
            } else {
                let kind = match schedule.kind.as_deref() {
                    Some("timer") => ScheduleKind::Timer,
                    _ => ScheduleKind::Schedule,
                };
                if kind == ScheduleKind::Timer
                    && schedule.duration_ms.filter(|value| *value > 0).is_none()
                {
                    let result = ScheduleMutation {
                        ok: false,
                        item: None,
                        items: state.schedule_store.list_user_pending(owner_user_id),
                        error: Some("타이머 시간을 확인하지 못했습니다.".to_string()),
                    };
                    return send_schedule_result(
                        bot,
                        msg,
                        state,
                        owner_user_id,
                        render_schedule_add_result(&result),
                    )
                    .await;
                }
                let due_at_ms = schedule.due_at_ms.unwrap_or_default();
                let title = schedule.title.unwrap_or_else(|| {
                    if kind == ScheduleKind::Timer {
                        "타이머".to_string()
                    } else {
                        "일정".to_string()
                    }
                });
                let result = state
                    .schedule_store
                    .add(NewSchedule {
                        owner_user_id,
                        chat_id: msg.chat.id,
                        message_thread_id: msg.thread_id,
                        source_message_id: Some(msg.id),
                        kind,
                        title,
                        due_at_ms,
                    })
                    .await?;
                render_schedule_add_result(&result)
            }
        }
        _ => return Ok(false),
    };

    let sent = send_reply_with_fallback(bot, msg, message, SendOptions::default()).await?;
    state
        .record_planabrain_reply_for_user(
            &sent,
            &format!("schedule_{owner_user_id}"),
            owner_user_id,
        )
        .await;
    Ok(true)
}

pub(super) async fn send_schedule_result<B>(
    bot: &B,
    msg: &Message,
    state: &AppState,
    owner_user_id: u64,
    message: String,
) -> Result<bool, anyhow::Error>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let sent = send_reply_with_fallback(bot, msg, message, SendOptions::default()).await?;
    state
        .record_planabrain_reply_for_user(
            &sent,
            &format!("schedule_{owner_user_id}"),
            owner_user_id,
        )
        .await;
    Ok(true)
}
