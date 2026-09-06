use anyhow::Result;
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardMarkup, InputFile, Message, ParseMode, ReplyParameters};
use teloxide::utils::markdown;

#[derive(Clone, Default)]
pub(crate) struct SendOptions {
    pub reply_markup: Option<InlineKeyboardMarkup>,
    pub disable_preview: Option<bool>,
    pub disable_notification: Option<bool>,
    pub parse_mode: Option<ParseMode>,
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

pub(crate) fn send_in_chat<B>(bot: &B, msg: &Message, text: impl Into<String>) -> B::SendMessage
where
    B: Requester + ?Sized,
{
    bot.send_message(msg.chat.id, text.into())
}

pub(crate) fn reply_in_thread<B>(bot: &B, msg: &Message, text: impl Into<String>) -> B::SendMessage
where
    B: Requester + ?Sized,
{
    let mut req = bot
        .send_message(msg.chat.id, text.into())
        .reply_parameters(ReplyParameters::new(msg.id).allow_sending_without_reply());
    if let Some(thread_id) = msg.thread_id {
        req = req.message_thread_id(thread_id);
    }
    req
}

pub(crate) fn reply_in_chat<B>(bot: &B, msg: &Message, text: impl Into<String>) -> B::SendMessage
where
    B: Requester + ?Sized,
{
    bot.send_message(msg.chat.id, text.into())
        .reply_parameters(ReplyParameters::new(msg.id).allow_sending_without_reply())
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
        Err(err) => {
            let err_text = err.to_string().to_lowercase();
            if err_text.contains("message thread not found") {
                let fallback =
                    apply_send_options::<B>(reply_in_chat(bot, msg, text.clone()), &opts);
                return match fallback.await {
                    Ok(message) => Ok(message),
                    Err(err) => {
                        if err
                            .to_string()
                            .to_lowercase()
                            .contains("message to be replied not found")
                        {
                            let fallback =
                                apply_send_options::<B>(send_in_chat(bot, msg, text), &opts);
                            Ok(fallback.await?)
                        } else {
                            Err(err.into())
                        }
                    }
                };
            }

            if err_text.contains("message to be replied not found") {
                let fallback = apply_send_options::<B>(send_in_thread(bot, msg, text), &opts);
                return Ok(fallback.await?);
            }

            Err(err.into())
        }
    }
}

pub(crate) async fn send_reply_markdown_with_fallback<B>(
    bot: &B,
    msg: &Message,
    text: impl Into<String>,
    mut opts: SendOptions,
) -> Result<Message>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let text = text.into();
    opts.parse_mode = Some(ParseMode::MarkdownV2);
    match send_reply_with_fallback(bot, msg, text.clone(), opts.clone()).await {
        Ok(message) => Ok(message),
        Err(err) => {
            if is_parse_entities_error(&err) {
                let escaped = markdown::escape(&text);
                return send_reply_with_fallback(bot, msg, escaped, opts).await;
            }
            Err(err)
        }
    }
}

pub(crate) async fn send_reply_html_with_fallback<B>(
    bot: &B,
    msg: &Message,
    html_text: String,
    plain_text: String,
    mut opts: SendOptions,
) -> Result<Message>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    opts.parse_mode = Some(ParseMode::Html);
    match send_reply_with_fallback(bot, msg, html_text, opts.clone()).await {
        Ok(message) => Ok(message),
        Err(err) => {
            if is_parse_entities_error(&err) {
                opts.parse_mode = None;
                return send_reply_with_fallback(bot, msg, plain_text, opts).await;
            }
            Err(err)
        }
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
    if let Some(parse_mode) = opts.parse_mode {
        req = req.parse_mode(parse_mode);
    }
    req
}

fn is_parse_entities_error(err: &anyhow::Error) -> bool {
    let text = err.to_string().to_lowercase();
    text.contains("can't parse entities") || text.contains("cannot parse entities")
}

pub(crate) fn send_photo_in_thread<B>(bot: &B, msg: &Message, photo: InputFile) -> B::SendPhoto
where
    B: Requester + ?Sized,
{
    let mut req = bot.send_photo(msg.chat.id, photo);
    if let Some(thread_id) = msg.thread_id {
        req = req.message_thread_id(thread_id);
    }
    req
}

pub(crate) fn send_video_in_thread<B>(bot: &B, msg: &Message, video: InputFile) -> B::SendVideo
where
    B: Requester + ?Sized,
{
    let mut req = bot.send_video(msg.chat.id, video);
    if let Some(thread_id) = msg.thread_id {
        req = req.message_thread_id(thread_id);
    }
    req
}

fn send_photo_in_chat<B>(bot: &B, msg: &Message, photo: InputFile) -> B::SendPhoto
where
    B: Requester + ?Sized,
{
    bot.send_photo(msg.chat.id, photo)
}

fn reply_photo_in_thread<B>(bot: &B, msg: &Message, photo: InputFile) -> B::SendPhoto
where
    B: Requester + ?Sized,
{
    send_photo_in_thread(bot, msg, photo)
        .reply_parameters(ReplyParameters::new(msg.id).allow_sending_without_reply())
}

fn reply_photo_in_chat<B>(bot: &B, msg: &Message, photo: InputFile) -> B::SendPhoto
where
    B: Requester + ?Sized,
{
    bot.send_photo(msg.chat.id, photo)
        .reply_parameters(ReplyParameters::new(msg.id).allow_sending_without_reply())
}

pub(crate) async fn send_photo_reply_with_fallback<B>(
    bot: &B,
    msg: &Message,
    photo: InputFile,
    caption: impl Into<String>,
    opts: SendOptions,
) -> Result<Message>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let caption = caption.into();
    let request = apply_photo_send_options::<B>(
        reply_photo_in_thread(bot, msg, photo.clone()),
        &caption,
        &opts,
    );

    match request.await {
        Ok(message) => Ok(message),
        Err(err) => {
            let err_text = err.to_string().to_lowercase();
            if is_thread_not_found(&err_text) {
                let fallback = apply_photo_send_options::<B>(
                    reply_photo_in_chat(bot, msg, photo.clone()),
                    &caption,
                    &opts,
                );
                return match fallback.await {
                    Ok(message) => Ok(message),
                    Err(err) => {
                        if is_reply_target_missing(&err.to_string().to_lowercase()) {
                            let fallback = apply_photo_send_options::<B>(
                                send_photo_in_chat(bot, msg, photo),
                                &caption,
                                &opts,
                            );
                            Ok(fallback.await?)
                        } else {
                            Err(err.into())
                        }
                    }
                };
            }

            if is_reply_target_missing(&err_text) {
                let fallback = apply_photo_send_options::<B>(
                    send_photo_in_thread(bot, msg, photo),
                    &caption,
                    &opts,
                );
                return Ok(fallback.await?);
            }

            Err(err.into())
        }
    }
}

fn apply_photo_send_options<B>(
    mut req: B::SendPhoto,
    caption: &str,
    opts: &SendOptions,
) -> B::SendPhoto
where
    B: Requester + ?Sized,
{
    if !caption.is_empty() {
        req = req.caption(caption.to_string());
    }
    if let Some(markup) = &opts.reply_markup {
        req = req.reply_markup(markup.clone());
    }
    if let Some(disable_notification) = opts.disable_notification {
        req = req.disable_notification(disable_notification);
    }
    if let Some(parse_mode) = opts.parse_mode {
        req = req.parse_mode(parse_mode);
    }
    req
}

fn send_video_in_chat<B>(bot: &B, msg: &Message, video: InputFile) -> B::SendVideo
where
    B: Requester + ?Sized,
{
    bot.send_video(msg.chat.id, video)
}

fn reply_video_in_thread<B>(bot: &B, msg: &Message, video: InputFile) -> B::SendVideo
where
    B: Requester + ?Sized,
{
    send_video_in_thread(bot, msg, video)
        .reply_parameters(ReplyParameters::new(msg.id).allow_sending_without_reply())
}

fn reply_video_in_chat<B>(bot: &B, msg: &Message, video: InputFile) -> B::SendVideo
where
    B: Requester + ?Sized,
{
    bot.send_video(msg.chat.id, video)
        .reply_parameters(ReplyParameters::new(msg.id).allow_sending_without_reply())
}

pub(crate) async fn send_video_reply_with_fallback<B>(
    bot: &B,
    msg: &Message,
    video: InputFile,
    caption: impl Into<String>,
    opts: SendOptions,
) -> Result<Message>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
{
    let caption = caption.into();
    let request = apply_video_send_options::<B>(
        reply_video_in_thread(bot, msg, video.clone()),
        &caption,
        &opts,
    );

    match request.await {
        Ok(message) => Ok(message),
        Err(err) => {
            let err_text = err.to_string().to_lowercase();
            if is_thread_not_found(&err_text) {
                let fallback = apply_video_send_options::<B>(
                    reply_video_in_chat(bot, msg, video.clone()),
                    &caption,
                    &opts,
                );
                return match fallback.await {
                    Ok(message) => Ok(message),
                    Err(err) => {
                        if is_reply_target_missing(&err.to_string().to_lowercase()) {
                            let fallback = apply_video_send_options::<B>(
                                send_video_in_chat(bot, msg, video),
                                &caption,
                                &opts,
                            );
                            Ok(fallback.await?)
                        } else {
                            Err(err.into())
                        }
                    }
                };
            }

            if is_reply_target_missing(&err_text) {
                let fallback = apply_video_send_options::<B>(
                    send_video_in_thread(bot, msg, video),
                    &caption,
                    &opts,
                );
                return Ok(fallback.await?);
            }

            Err(err.into())
        }
    }
}

fn apply_video_send_options<B>(
    mut req: B::SendVideo,
    caption: &str,
    opts: &SendOptions,
) -> B::SendVideo
where
    B: Requester + ?Sized,
{
    req = req.supports_streaming(true);
    if !caption.is_empty() {
        req = req.caption(caption.to_string());
    }
    if let Some(markup) = &opts.reply_markup {
        req = req.reply_markup(markup.clone());
    }
    if let Some(disable_notification) = opts.disable_notification {
        req = req.disable_notification(disable_notification);
    }
    if let Some(parse_mode) = opts.parse_mode {
        req = req.parse_mode(parse_mode);
    }
    req
}

fn is_thread_not_found(err_text: &str) -> bool {
    err_text.contains("message thread not found")
}

fn is_reply_target_missing(err_text: &str) -> bool {
    err_text.contains("message to be replied not found")
}
