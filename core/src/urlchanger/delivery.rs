use crate::bot::{
    HandlerResult, SendOptions, send_in_thread, send_photo_in_thread,
    send_photo_reply_with_fallback, send_reply_with_fallback, send_video_in_thread,
    send_video_reply_with_fallback,
};
use log::warn;
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardMarkup, InputFile, ParseMode};

pub(super) enum ReplyContent {
    Text(String),
    Photo {
        file: InputFile,
        caption: String,
        text_fallback: Option<String>,
    },
    Video {
        file: InputFile,
        caption: String,
        text_fallback: Option<String>,
    },
}

impl ReplyContent {
    #[cfg(test)]
    pub(super) fn text(&self) -> Option<&str> {
        match self {
            ReplyContent::Text(text) => Some(text),
            _ => None,
        }
    }

    #[cfg(test)]
    pub(super) fn text_fallback(&self) -> Option<&str> {
        match self {
            ReplyContent::Photo { text_fallback, .. }
            | ReplyContent::Video { text_fallback, .. } => text_fallback.as_deref(),
            ReplyContent::Text(_) => None,
        }
    }
}

pub(super) struct LinkReply {
    pub content: ReplyContent,
    pub markup: Option<InlineKeyboardMarkup>,
    pub disable_preview: Option<bool>,
    pub parse_mode: Option<ParseMode>,
}

impl LinkReply {
    fn new(content: ReplyContent) -> Self {
        Self {
            content,
            markup: None,
            disable_preview: None,
            parse_mode: None,
        }
    }

    pub(super) fn text(text: impl Into<String>) -> Self {
        Self::new(ReplyContent::Text(text.into()))
    }

    pub(super) fn photo(file: InputFile, caption: impl Into<String>) -> Self {
        Self::new(ReplyContent::Photo {
            file,
            caption: caption.into(),
            text_fallback: None,
        })
    }

    pub(super) fn video(file: InputFile, caption: impl Into<String>) -> Self {
        Self::new(ReplyContent::Video {
            file,
            caption: caption.into(),
            text_fallback: None,
        })
    }

    pub(super) fn with_markup(mut self, markup: Option<InlineKeyboardMarkup>) -> Self {
        self.markup = markup;
        self
    }

    pub(super) fn with_disable_preview(mut self, disable_preview: bool) -> Self {
        self.disable_preview = Some(disable_preview);
        self
    }

    pub(super) fn with_parse_mode(mut self, parse_mode: ParseMode) -> Self {
        self.parse_mode = Some(parse_mode);
        self
    }

    pub(super) fn with_text_fallback(mut self, text: impl Into<String>) -> Self {
        match &mut self.content {
            ReplyContent::Photo { text_fallback, .. }
            | ReplyContent::Video { text_fallback, .. } => {
                *text_fallback = Some(text.into());
            }
            ReplyContent::Text(_) => {}
        }
        self
    }

    fn send_options(&self) -> SendOptions {
        SendOptions {
            reply_markup: self.markup.clone(),
            disable_preview: self.disable_preview,
            parse_mode: self.parse_mode,
            ..SendOptions::default()
        }
    }
}

pub(super) struct LinkPlan {
    pub admin: Vec<LinkReply>,
    pub reply: Vec<LinkReply>,
}

pub(super) async fn deliver_link_plan<B>(
    bot: &B,
    msg: &Message,
    privileged: bool,
    label: &str,
    plan: LinkPlan,
) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    if privileged {
        match bot.delete_message(msg.chat.id, msg.id).await {
            Ok(_) => {
                for reply in plan.admin {
                    send_new_message(bot, msg, reply).await?;
                }
                return Ok(());
            }
            Err(e) => warn!("{} 메시지 삭제 실패: {:?}", label, e),
        }
    }

    for reply in plan.reply {
        send_as_reply(bot, msg, reply).await?;
    }
    Ok(())
}

async fn send_new_message<B>(bot: &B, msg: &Message, reply: LinkReply) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    let markup = reply.markup.clone();
    let parse_mode = reply.parse_mode;
    let disable_preview = reply.disable_preview;
    match reply.content {
        ReplyContent::Text(text) => {
            let mut request = send_in_thread(bot, msg, text);
            if let Some(markup) = markup {
                request = request.reply_markup(markup);
            }
            if let Some(disable_preview) = disable_preview {
                request = request.disable_link_preview(disable_preview);
            }
            if let Some(parse_mode) = parse_mode {
                request = request.parse_mode(parse_mode);
            }
            request.await?;
        }
        ReplyContent::Photo {
            file,
            caption,
            text_fallback,
        } => {
            let mut request = send_photo_in_thread(bot, msg, file);
            if !caption.is_empty() {
                request = request.caption(caption);
            }
            if let Some(markup) = markup.clone() {
                request = request.reply_markup(markup);
            }
            if let Some(parse_mode) = parse_mode {
                request = request.parse_mode(parse_mode);
            }
            if let Err(e) = request.await {
                let Some(text) = text_fallback else {
                    return Err(e.into());
                };
                warn!("사진 전송 실패, 텍스트로 대체합니다: {:?}", e);
                let mut request = send_in_thread(bot, msg, text);
                if let Some(markup) = markup {
                    request = request.reply_markup(markup);
                }
                request.await?;
            }
        }
        ReplyContent::Video {
            file,
            caption,
            text_fallback,
        } => {
            let mut request = send_video_in_thread(bot, msg, file).supports_streaming(true);
            if !caption.is_empty() {
                request = request.caption(caption);
            }
            if let Some(markup) = markup.clone() {
                request = request.reply_markup(markup);
            }
            if let Some(parse_mode) = parse_mode {
                request = request.parse_mode(parse_mode);
            }
            if let Err(e) = request.await {
                let Some(text) = text_fallback else {
                    return Err(e.into());
                };
                warn!("동영상 전송 실패, 텍스트로 대체합니다: {:?}", e);
                let mut request = send_in_thread(bot, msg, text);
                if let Some(markup) = markup {
                    request = request.reply_markup(markup);
                }
                request.await?;
            }
        }
    }
    Ok(())
}

async fn send_as_reply<B>(bot: &B, msg: &Message, reply: LinkReply) -> HandlerResult
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    let opts = reply.send_options();
    match reply.content {
        ReplyContent::Text(text) => {
            send_reply_with_fallback(bot, msg, text, opts).await?;
        }
        ReplyContent::Photo {
            file,
            caption,
            text_fallback,
        } => {
            if let Err(e) =
                send_photo_reply_with_fallback(bot, msg, file, caption, opts.clone()).await
            {
                let Some(text) = text_fallback else {
                    return Err(e);
                };
                warn!("사진 답장 실패, 텍스트로 대체합니다: {:?}", e);
                send_reply_with_fallback(bot, msg, text, opts).await?;
            }
        }
        ReplyContent::Video {
            file,
            caption,
            text_fallback,
        } => {
            if let Err(e) =
                send_video_reply_with_fallback(bot, msg, file, caption, opts.clone()).await
            {
                let Some(text) = text_fallback else {
                    return Err(e);
                };
                warn!("동영상 답장 실패, 텍스트로 대체합니다: {:?}", e);
                send_reply_with_fallback(bot, msg, text, opts).await?;
            }
        }
    }
    Ok(())
}
