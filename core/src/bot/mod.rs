mod commands;
mod gallery;
mod handlers;
mod state;
mod telegram;

use anyhow::Result;
use log::error;
use std::sync::Arc;
use teloxide::dispatching::UpdateFilterExt;
use teloxide::filter_command;
use teloxide::prelude::*;
use teloxide::types::Message;
use teloxide::utils::command::BotCommands;

use crate::urlchanger;

pub use state::AppState;
pub(crate) use telegram::{SendOptions, send_in_thread, send_reply_with_fallback};

pub type HandlerResult = Result<()>;

pub async fn run<B>(bot: B, state: AppState) -> Result<()>
where
    B: Requester + teloxide::net::Download + Clone + Send + Sync + 'static,
    <B as Requester>::Err: std::error::Error + Send + Sync + 'static,
    B::SendChatAction: Send,
    <B as Requester>::GetUpdates: Send,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::CopyMessage: Send,
    <B as Requester>::GetFile: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::EditMessageText: Send,
    <B as Requester>::EditMessageCaption: Send,
    <B as Requester>::SetMessageReaction: Send,
    <B as teloxide::net::Download>::StreamErr: std::fmt::Debug + Send,
    <B as teloxide::net::Download>::Stream: Unpin + Send,
{
    bot.set_my_commands(commands::Command::bot_commands())
        .await?;

    let error_handler = Arc::new(|err| async move {
        if should_reboot_on_handler_error(&err) {
            error!("치명적인 통신 오류 감지: {:?}", err);
            crate::reboot::trigger_failure_reboot("통신 불능 오류로 인한 재시동");
        } else {
            error!("핸들러 오류: {:?}", err);
        }
    });

    let handler = dptree::entry()
        .branch(
            Update::filter_message()
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
        .enable_ctrlc_handler()
        .distribution_function(|upd| upd.from().map(|user| user.id))
        .default_handler(|_| async move {})
        .error_handler(error_handler)
        .build();

    let update_listener = teloxide::update_listeners::polling_default(bot).await;
    let update_listener_error_handler = Arc::new(|err| async move {
        if should_reboot_on_update_error(&err) {
            error!("업데이트 리스너 통신 오류 감지: {:?}", err);
            crate::reboot::trigger_failure_reboot("업데이트 리스너 통신 오류로 인한 재시동");
        } else {
            error!("업데이트 리스너 오류: {:?}", err);
        }
    });

    dispatcher
        .dispatch_with_listener(update_listener, update_listener_error_handler)
        .await;

    Ok(())
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
