use anyhow::Result;
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardMarkup, Message, ReplyParameters};

#[derive(Clone, Default)]
pub(crate) struct SendOptions {
    pub reply_markup: Option<InlineKeyboardMarkup>,
    pub disable_preview: Option<bool>,
    pub disable_notification: Option<bool>,
}

pub(crate) fn send_in_thread<B>(bot: &B, msg: &Message, text: impl Into<String>) -> B::SendMessage
where
    B: Requester + ?Sized,
{
    let mut req = bot.send_message(msg.chat.id, text.into());
    if let Some(thread_id) = msg.thread_id {
        req = req.message_thread_id(thread_id);
    }
    req
}

pub(crate) fn reply_in_thread<B>(
    bot: &B,
    msg: &Message,
    text: impl Into<String>,
) -> B::SendMessage
where
    B: Requester + ?Sized,
{
    let mut req = bot.send_message(msg.chat.id, text.into()).reply_parameters(
        ReplyParameters::new(msg.id).allow_sending_without_reply(),
    );
    if let Some(thread_id) = msg.thread_id {
        req = req.message_thread_id(thread_id);
    }
    req
}

pub(crate) async fn send_reply_with_fallback<B>(
    bot: &B,
    msg: &Message,
    text: impl Into<String>,
    opts: SendOptions,
) -> Result<Message>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let text = text.into();
    let request = apply_send_options::<B>(reply_in_thread(bot, msg, text.clone()), &opts);

    match request.await {
        Ok(message) => Ok(message),
        Err(err) if err.to_string().contains("message to be replied not found") => {
            let fallback = apply_send_options::<B>(send_in_thread(bot, msg, text), &opts);
            Ok(fallback.await?)
        }
        Err(err) => Err(err.into()),
    }
}

fn apply_send_options<B>(mut req: B::SendMessage, opts: &SendOptions) -> B::SendMessage
where
    B: Requester + ?Sized,
{
    if let Some(markup) = &opts.reply_markup {
        req = req.reply_markup(markup.clone());
    }
    if let Some(disable_preview) = opts.disable_preview {
        req = req.disable_link_preview(disable_preview);
    }
    if let Some(disable_notification) = opts.disable_notification {
        req = req.disable_notification(disable_notification);
    }
    req
}
