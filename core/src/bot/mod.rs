mod commands;
mod gallery;
mod handlers;
mod state;
mod telegram;

use anyhow::Result;
use teloxide::dispatching::UpdateFilterExt;
use teloxide::filter_command;
use teloxide::prelude::*;
use teloxide::types::Message;
use teloxide::utils::command::BotCommands;

use crate::urlchanger;

pub(crate) use telegram::{send_in_thread, send_reply_with_fallback, SendOptions};
pub use state::AppState;

pub type HandlerResult = Result<()>;

pub async fn run<B>(bot: B, state: AppState) -> Result<()>
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendChatAction: Send,
    <B as Requester>::GetUpdates: Send,
    <B as Requester>::GetChatMember: Send,
{
    bot.set_my_commands(commands::Command::bot_commands()).await?;

    let handler = dptree::entry()
        .branch(
            Update::filter_message()
                .branch(filter_command::<commands::Command, _>().endpoint(handlers::handle_command::<B>))
                .branch(
                    dptree::filter(|msg: Message, state: AppState| {
                        handlers::is_plana_trigger(&msg, &state)
                    })
                    .endpoint(handlers::handle_plana_message::<B>),
                )
                .branch(urlchanger::url_handlers::<B>())
                .branch(dptree::endpoint(handlers::handle_message::<B>)),
        )
        .branch(Update::filter_callback_query().endpoint(handlers::handle_callback::<B>));

    Dispatcher::builder(bot, handler)
        .dependencies(dptree::deps![state])
        .enable_ctrlc_handler()
        .default_handler(|_| async move {})
        .build()
        .dispatch()
        .await;

    Ok(())
}
