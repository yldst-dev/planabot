mod commands;
mod gallery;
mod handlers;
mod media;
mod notice;
mod state;
mod telegram;

use anyhow::Result;
use log::{error, info, warn};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use teloxide::dispatching::{ShutdownToken, UpdateFilterExt};
use teloxide::filter_command;
use teloxide::prelude::*;
use teloxide::stop::StopToken;
use teloxide::types::{BotCommandScope, Message};
use teloxide::update_listeners::UpdateListener;
use teloxide::utils::command::BotCommands;

use crate::urlchanger;

pub(crate) use gallery::extract_gallery_id_from_url;
pub use state::AppState;
pub(crate) use telegram::{
    SendOptions, send_in_thread, send_photo_in_thread, send_photo_reply_with_fallback,
    send_reply_with_fallback, send_video_in_thread, send_video_reply_with_fallback,
};

pub type HandlerResult = Result<()>;

const TURN_DRAIN_LIMIT: Duration = Duration::from_secs(190);

const SHUTDOWN_WATCHDOG: Duration = Duration::from_secs(225);

const FINAL_CONFIRM_LIMIT: Duration = Duration::from_secs(3);

static SHUTDOWN: OnceLock<ShutdownToken> = OnceLock::new();
static LISTENER_STOP: OnceLock<StopToken> = OnceLock::new();
static SHUTDOWN_REQUESTED: AtomicBool = AtomicBool::new(false);
static NEXT_OFFSET: AtomicI32 = AtomicI32::new(0);

pub(crate) fn request_shutdown() -> bool {
    let Some(token) = SHUTDOWN.get() else {
        return false;
    };
    if SHUTDOWN_REQUESTED.swap(true, Ordering::SeqCst) {
        return true;
    }
    state::note_shutdown_start();
    let accepted = token.shutdown().is_ok();
    if accepted {
        if let Some(listener) = LISTENER_STOP.get() {
            listener.stop();
        }
        std::thread::spawn(|| {
            std::thread::sleep(SHUTDOWN_WATCHDOG);
            crate::reboot::trigger_failure_reboot("종료 대기 시간 초과");
        });
    }
    accepted
}

fn is_shutting_down() -> bool {
    SHUTDOWN_REQUESTED.load(Ordering::SeqCst)
}

fn on_stop_signal() {
    info!("종료 신호 수신: 처리 중인 답변을 마친 뒤 종료합니다.");
    if !request_shutdown() {
        crate::reboot::trigger_scheduled_reboot("종료 신호 수신");
    }
}

pub async fn run<B>(bot: B, state: AppState) -> Result<()>
where
    B: Requester + teloxide::net::Download + Clone + Send + Sync + 'static,
    <B as Requester>::Err: std::error::Error + Send + Sync + 'static,
    B::SendChatAction: Send,
    <B as Requester>::GetUpdates: Send,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::CopyMessage: Send,
    <B as Requester>::CopyMessages: Send,
    <B as Requester>::GetFile: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
    <B as Requester>::SendDocument: Send,
    <B as Requester>::EditMessageText: Send,
    <B as Requester>::EditMessageReplyMarkup: Send,
    <B as Requester>::EditMessageCaption: Send,
    <B as Requester>::SetMessageReaction: Send,
    <B as teloxide::net::Download>::StreamErr: std::fmt::Debug + Send,
    <B as teloxide::net::Download>::Stream: Unpin + Send,
{
    media::clear_image_dir();
    let private_commands = commands::Command::bot_commands();
    let shared_commands: Vec<_> = private_commands
        .iter()
        .filter(|command| command.command.trim_start_matches('/') != commands::PRIVATE_ONLY_COMMAND)
        .cloned()
        .collect();
    bot.set_my_commands(shared_commands).await?;
    bot.set_my_commands(private_commands)
        .scope(BotCommandScope::AllPrivateChats)
        .await?;

    let error_handler = Arc::new(|err| async move { report_handler_error(&err) });
    let drain_state = state.clone();

    let handler = dptree::entry()
        .inspect(|upd: Update| {
            NEXT_OFFSET.fetch_max(upd.id.as_offset(), Ordering::SeqCst);
        })
        .inspect(state::consume_shutdown_mark)
        .branch(
            Update::filter_message()
                .inspect(|msg: Message, state: AppState| state.record_media_group(&msg))
                .branch(
                    filter_command::<commands::Command, _>()
                        .endpoint(handlers::handle_command::<B>),
                )
                .branch(
                    dptree::filter(|msg: Message, state: AppState| {
                        handlers::is_plana_trigger(&msg, &state)
                    })
                    .endpoint(handlers::handle_plana_message::<B>),
                )
                .branch(urlchanger::url_handlers::<B>())
                .branch(dptree::endpoint(handlers::handle_message::<B>)),
        )
        .branch(Update::filter_channel_post().endpoint(handlers::handle_notice_post::<B>))
        .branch(Update::filter_edited_channel_post().endpoint(handlers::handle_notice_edit::<B>))
        .branch(Update::filter_callback_query().endpoint(handlers::handle_callback::<B>));

    let mut dispatcher = Dispatcher::builder(bot.clone(), handler)
        .dependencies(dptree::deps![state])
        .distribution_function(|upd| {
            upd.from()
                .map(|user| user.id.0 as i64)
                .or_else(|| upd.chat().map(|chat| chat.id.0))
        })
        .default_handler(|_| async move {})
        .error_handler(error_handler)
        .build();
    let _ = SHUTDOWN.set(dispatcher.shutdown_token());
    tokio::spawn(async {
        while tokio::signal::ctrl_c().await.is_ok() {
            on_stop_signal();
        }
    });
    #[cfg(unix)]
    tokio::spawn(async {
        use tokio::signal::unix::{SignalKind, signal};
        if let Ok(mut terminate) = signal(SignalKind::terminate()) {
            while terminate.recv().await.is_some() {
                on_stop_signal();
            }
        }
    });

    let mut update_listener = teloxide::update_listeners::polling_default(bot.clone()).await;
    let _ = LISTENER_STOP.set(update_listener.stop_token());
    let update_listener_error_handler = Arc::new(|err| async move {
        if !is_shutting_down() && should_reboot_on_update_error(&err) {
            error!("업데이트 리스너 통신 오류 감지: {:?}", err);
            crate::reboot::trigger_failure_reboot("업데이트 리스너 통신 오류로 인한 재시동");
        } else {
            error!("업데이트 리스너 오류: {:?}", err);
        }
    });

    dispatcher
        .dispatch_with_listener(update_listener, update_listener_error_handler)
        .await;
    SHUTDOWN_REQUESTED.store(true, Ordering::SeqCst);
    let shutdown_started = state::note_shutdown_start();
    state::record_shutdown_mark().await;
    let offset = NEXT_OFFSET.load(Ordering::SeqCst);
    let remaining = TURN_DRAIN_LIMIT.saturating_sub(shutdown_started.elapsed());
    if offset > 0 && !remaining.is_zero() {
        let confirm = bot.get_updates().offset(offset).limit(1).timeout(0).send();
        let _ = tokio::time::timeout(FINAL_CONFIRM_LIMIT.min(remaining), confirm).await;
    }
    let budget = TURN_DRAIN_LIMIT.saturating_sub(shutdown_started.elapsed());
    if !drain_state.tasks.drain(budget).await {
        warn!("처리 중인 작업을 기다리다 시간이 지나 종료합니다.");
    }

    Ok(())
}

pub(crate) fn is_transient_request_error(err: &teloxide::RequestError) -> bool {
    matches!(
        err,
        teloxide::RequestError::Network(_) | teloxide::RequestError::Io(_)
    )
}

pub(crate) fn should_reboot_on_request_error(err: &teloxide::RequestError) -> bool {
    match err {
        teloxide::RequestError::Network(network_err) => !network_err.is_timeout(),
        teloxide::RequestError::InvalidJson { .. } | teloxide::RequestError::Io(_) => true,
        _ => false,
    }
}

fn should_reboot_on_update_error<E>(err: &E) -> bool
where
    E: std::error::Error + 'static,
{
    let err = err as &(dyn std::error::Error + 'static);
    if let Some(request_error) = err.downcast_ref::<teloxide::RequestError>() {
        return should_reboot_on_request_error(request_error);
    }
    false
}

pub(crate) fn report_handler_error(err: &anyhow::Error) {
    if !is_shutting_down() && should_reboot_on_handler_error(err) {
        error!("치명적인 통신 오류 감지: {:?}", err);
        crate::reboot::trigger_failure_reboot("통신 불능 오류로 인한 재시동");
    } else {
        error!("핸들러 오류: {:?}", err);
    }
}

fn should_reboot_on_handler_error(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| {
        if let Some(request_error) = cause.downcast_ref::<teloxide::RequestError>() {
            return should_reboot_on_request_error(request_error);
        }
        if let Some(download_error) = cause.downcast_ref::<teloxide::DownloadError>() {
            return matches!(
                download_error,
                teloxide::DownloadError::Network(_) | teloxide::DownloadError::Io(_)
            );
        }
        false
    })
}
