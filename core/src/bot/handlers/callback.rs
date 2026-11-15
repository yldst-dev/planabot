use anyhow::Result;
use log::{error, warn};
use teloxide::prelude::*;
use teloxide::types::{
    CallbackQuery, ChatId, ChatKind, InlineKeyboardButton, InlineKeyboardMarkup, InputFile,
    ParseMode, ReplyParameters, UserId,
};
use teloxide::utils::html;
use url::Url;

use super::super::gallery::{
    build_gallery_keyboard, build_gallery_preparing_keyboard, build_share_ready_keyboard,
    download_action_button, fetch_action_button, is_gallery_id, preparing_action_button,
    render_gallery_message, replace_gallery_action_button,
};
use super::super::{AppState, HandlerResult, SENDER_CHAT_USER_BASE};
use crate::schedule::{RESTORE_CALLBACK_PREFIX, render_schedule_restore_result};

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

    if let Some(id) = data.strip_prefix(RESTORE_CALLBACK_PREFIX) {
        handle_restore_callback(&bot, &query, &state, id).await?;
        return Ok(());
    }

    if let Some(gallery_id) = data.strip_prefix("prep_") {
        if state.is_gallery_job_running(gallery_id) {
            let _ = bot
                .answer_callback_query(query.id)
                .text("대기 중.\n선생님.\n뷰어를 준비합니다.")
                .await;
        } else {
            handle_fetch_callback(&bot, &query, &state, gallery_id).await?;
        }
        return Ok(());
    }

    if let Some(token) = data.strip_prefix("dl_") {
        handle_download_callback(&bot, &query, &state, token).await?;
        return Ok(());
    }

    if let Some(gallery_id) = data.strip_prefix("save_") {
        if !is_gallery_id(gallery_id) {
            bot.answer_callback_query(query.id).await?;
            return Ok(());
        }
        let info = match state.gallery_client.get_gallery_info(gallery_id).await {
            Ok(info) => info,
            Err(err) => {
                error!("갤러리 조회 실패 (callback, ID {}): {}", gallery_id, err);
                let _ = bot
                    .answer_callback_query(query.id)
                    .text(
                        "오류.\n선생님.\n갤러리 정보를 불러오지 못했습니다.\n잠시 후 다시 시도해 주십시오.",
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
                        .text("불가.\n선생님.\n개인 대화를 먼저 시작해 주십시오.\n차단 해제가 필요합니다.")
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

async fn handle_restore_callback<B>(
    bot: &B,
    query: &CallbackQuery,
    state: &AppState,
    id: &str,
) -> HandlerResult
where
    B: Requester,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let Some(msg) = query.regular_message() else {
        let _ = bot
            .answer_callback_query(query.id.clone())
            .text("불가.\n선생님.\n메시지를 찾지 못했습니다.")
            .show_alert(true)
            .await;
        return Ok(());
    };
    let group_owner_id = SENDER_CHAT_USER_BASE | msg.chat.id.0.unsigned_abs();
    let owner_user_id = if (msg.chat.is_group() || msg.chat.is_supergroup())
        && state.schedule_store.owner_of(id) == Some(group_owner_id)
        && bot
            .get_chat_member(msg.chat.id, query.from.id)
            .await
            .is_ok_and(|member| member.kind.is_anonymous())
    {
        group_owner_id
    } else {
        query.from.id.0
    };
    let result = state
        .schedule_store
        .restore(owner_user_id, msg.chat.id.0, id)
        .await?;
    if !result.ok {
        let _ = bot
            .answer_callback_query(query.id.clone())
            .text(render_schedule_restore_result(&result))
            .show_alert(true)
            .await;
        return Ok(());
    }
    let _ = bot
        .answer_callback_query(query.id.clone())
        .text("복구 완료.\n선생님.")
        .await;
    if let Err(err) = bot
        .edit_message_text(msg.chat.id, msg.id, render_schedule_restore_result(&result))
        .await
    {
        warn!("일정 복구 메시지 수정 실패: {}", err);
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
    if !is_gallery_id(gallery_id) {
        let _ = bot
            .answer_callback_query(query.id.clone())
            .text("확인 불가.\n선생님.\n갤러리 번호가 올바르지 않습니다.")
            .show_alert(true)
            .await;
        return Ok(());
    }
    let Some(msg) = query.regular_message() else {
        let _ = bot
            .answer_callback_query(query.id.clone())
            .text("불가.\n선생님.\n메시지를 찾지 못했습니다.")
            .show_alert(true)
            .await;
        return Ok(());
    };
    let Some(job) = state.start_gallery_job(gallery_id) else {
        let _ = bot
            .answer_callback_query(query.id.clone())
            .text("대기 중.\n선생님.\n이미 뷰어를 준비하고 있습니다.")
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
        let _job = job;
        let Some(_slot) = state.gallery_job_slot().await else {
            return;
        };
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
                state.put_share_claim(claim.clone()).await;
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
                if let Some(notice) = crate::hiromi_share::failure_notice(&err) {
                    let sent = bot
                        .send_message(chat_id, notice)
                        .reply_parameters(
                            ReplyParameters::new(message_id).allow_sending_without_reply(),
                        )
                        .await;
                    if let Err(err) = sent {
                        warn!("뷰어 실패 안내 전송 실패 (id {}): {}", gallery_id, err);
                    }
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
                .text("불가.\n선생님.\n개인 대화를 먼저 시작해 주십시오.\n차단 해제가 필요합니다.")
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
                                "불가.\n선생님.\n개인 대화를 먼저 시작해 주십시오.",
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
            "전송 완료.\n선생님.\n<b>제목:</b> {title}\n{pages}",
            pages = claim.pages_line()
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
        "전송 완료.\n선생님.\n<b>제목:</b> {title}\n{pages}\n{url}",
        pages = claim.pages_line()
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

#[cfg(test)]
mod tests {
    use crate::bot::SENDER_CHAT_USER_BASE;
    use crate::schedule::{NewSchedule, ScheduleKind, ScheduleStore, now_ms};
    use teloxide::types::{CallbackQuery, ChatId};

    const GROUP_ADMIN: u64 = SENDER_CHAT_USER_BASE | 100;

    fn member(status: &str, is_anonymous: bool) -> serde_json::Value {
        let mut member = serde_json::json!({
            "user": {"id": 7, "is_bot": false, "first_name": "A"},
            "status": status,
            "is_anonymous": is_anonymous,
        });
        if status == "administrator" {
            for right in [
                "can_manage_chat",
                "can_change_info",
                "can_delete_messages",
                "can_manage_video_chats",
                "can_invite_users",
                "can_restrict_members",
                "can_pin_messages",
                "can_promote_members",
            ] {
                member[right] = serde_json::json!(true);
            }
            member["can_be_edited"] = serde_json::json!(false);
        }
        serde_json::from_value::<teloxide::types::ChatMember>(member.clone()).unwrap();
        member
    }

    async fn restored_after_press(
        owner_user_id: u64,
        item_chat: i64,
        press_chat: i64,
        chat_member: Option<serde_json::Value>,
    ) -> bool {
        let api = axum::Router::new().fallback(move |uri: axum::http::Uri| {
            let chat_member = chat_member.clone();
            async move {
                let path = uri.path().to_ascii_lowercase();
                axum::Json(if path.ends_with("/getchatmember") {
                    match chat_member {
                        Some(member) => serde_json::json!({"ok": true, "result": member}),
                        None => serde_json::json!({"ok": false, "error_code": 400,
                            "description": "Bad Request: user not found"}),
                    }
                } else if path.ends_with("/editmessagetext") {
                    serde_json::json!({"ok": true, "result": {"message_id": 5, "date": 1, "text": "x",
                        "chat": {"id": press_chat, "title": "g", "type": "supergroup"}}})
                } else {
                    serde_json::json!({"ok": true, "result": true})
                })
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, api).await });
        let bot = teloxide::Bot::new("1:test").set_api_url(url.parse().unwrap());

        let mut state = crate::bot::AppState::new(
            "bot".into(),
            teloxide::types::UserId(1),
            crate::hitomi::GalleryClient::new(),
            None,
            None,
        );
        static SEQ: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let path = std::env::temp_dir().join(format!(
            "planabot_restore_press_{}_{}.json",
            now_ms(),
            SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        state.schedule_store = ScheduleStore::with_items(path.clone(), Vec::new());
        let item = state
            .schedule_store
            .add(NewSchedule {
                owner_user_id,
                chat_id: ChatId(item_chat),
                message_thread_id: None,
                source_message_id: None,
                kind: ScheduleKind::Schedule,
                title: "율무차".to_string(),
                due_at_ms: now_ms() + 60_000,
            })
            .await
            .unwrap()
            .item
            .unwrap();
        assert!(
            state
                .schedule_store
                .cancel(owner_user_id, item_chat, "율무차")
                .await
                .unwrap()
                .ok
        );

        let chat_type = if press_chat > 0 {
            serde_json::json!({"id": press_chat, "first_name": "A", "type": "private"})
        } else {
            serde_json::json!({"id": press_chat, "title": "g", "type": "supergroup"})
        };
        let query: CallbackQuery = serde_json::from_value(serde_json::json!({
            "id": "q1",
            "from": {"id": 7, "is_bot": false, "first_name": "A"},
            "chat_instance": "c",
            "data": format!("sundo_{}", item.id),
            "message": {"message_id": 5, "date": 1_700_000_000, "text": "취소 완료.",
                "chat": chat_type, "from": {"id": 1, "is_bot": true, "first_name": "bot"}}
        }))
        .unwrap();
        assert!(query.regular_message().is_some());
        super::handle_restore_callback(&bot, &query, &state, &item.id)
            .await
            .unwrap();
        let restored = !state
            .schedule_store
            .list_user_pending(owner_user_id, item_chat)
            .is_empty();
        let _ = std::fs::remove_file(path);
        restored
    }

    #[tokio::test]
    async fn an_anonymous_admin_restores_the_reminder_they_set_as_the_group() {
        let admin = Some(member("administrator", true));
        assert!(restored_after_press(GROUP_ADMIN, -100, -100, admin).await);
        let owner = Some(member("creator", true));
        assert!(restored_after_press(GROUP_ADMIN, -100, -100, owner).await);
    }

    #[tokio::test]
    async fn only_anonymous_admins_of_that_group_restore_a_group_owned_reminder() {
        for (press_chat, chat_member) in [
            (-100, Some(member("administrator", false))),
            (-100, Some(member("creator", false))),
            (-100, Some(member("member", false))),
            (-100, None),
            (-200, Some(member("administrator", true))),
            (7, Some(member("administrator", true))),
        ] {
            assert!(
                !restored_after_press(GROUP_ADMIN, -100, press_chat, chat_member.clone()).await,
                "{press_chat} {chat_member:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_anonymous_admin_cannot_restore_another_members_reminder() {
        let admin = Some(member("administrator", true));
        assert!(!restored_after_press(42, -100, -100, admin).await);
    }
}
