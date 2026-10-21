use crate::bot::{
    HandlerResult, SendOptions, send_in_thread, send_photo_in_thread,
    send_photo_reply_with_fallback, send_reply_with_fallback, send_video_in_thread,
    send_video_reply_with_fallback,
};
use log::warn;
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardMarkup, InputFile, ParseMode};

#[derive(Clone)]
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
        size: Option<(u32, u32)>,
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

#[derive(Clone)]
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

    pub(super) fn video(
        file: InputFile,
        caption: impl Into<String>,
        size: Option<(u32, u32)>,
    ) -> Self {
        Self::new(ReplyContent::Video {
            file,
            caption: caption.into(),
            size,
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
    let LinkPlan { admin, reply } = plan;
    if privileged {
        let mut posted = 0;
        let reposted: HandlerResult = async {
            for item in admin {
                send_new_message(bot, msg, item).await?;
                posted += 1;
            }
            Ok(())
        }
        .await;
        match reposted {
            Ok(()) => {
                if let Err(e) = bot.delete_message(msg.chat.id, msg.id).await {
                    warn!("{} 메시지 삭제 실패: {:?}", label, e);
                }
                return Ok(());
            }
            Err(e) if posted > 0 => {
                warn!(
                    "{} 새 메시지 일부만 전송, 원본은 남겨 둡니다: {:?}",
                    label, e
                );
                return Ok(());
            }
            Err(e) => warn!(
                "{} 새 메시지 전송 실패, 답장으로 대신합니다: {:?}",
                label, e
            ),
        }
    }

    for item in reply {
        send_as_reply(bot, msg, item).await?;
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
    match send_new_message_once(bot, msg, reply.clone()).await {
        Err(err)
            if msg.thread_id.is_some()
                && err
                    .to_string()
                    .to_lowercase()
                    .contains("message thread not found") =>
        {
            let mut in_chat = msg.clone();
            in_chat.thread_id = None;
            send_new_message_once(bot, &in_chat, reply).await
        }
        result => result,
    }
}

async fn send_new_message_once<B>(bot: &B, msg: &Message, reply: LinkReply) -> HandlerResult
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
            size,
            text_fallback,
        } => {
            let mut request = send_video_in_thread(bot, msg, file).supports_streaming(true);
            if let Some((width, height)) = size {
                request = request.width(width).height(height);
            }
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
            size,
            text_fallback,
        } => {
            let video_opts = SendOptions {
                video_size: size,
                ..opts.clone()
            };
            if let Err(e) =
                send_video_reply_with_fallback(bot, msg, file, caption, video_opts).await
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

#[cfg(test)]
mod tests {
    use super::{LinkPlan, LinkReply, deliver_link_plan};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn a_failed_admin_repost_falls_back_to_a_reply_and_keeps_the_original() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let api = axum::Router::new().fallback(move |uri: axum::http::Uri, body: String| {
            let seen = seen.clone();
            async move {
                let method = uri
                    .path()
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let replied = body.contains("reply_parameters");
                seen.lock().unwrap().push((method.clone(), replied));
                axum::Json(match (method.as_str(), replied) {
                    ("sendmessage", false) => serde_json::json!({
                        "ok": false, "error_code": 400, "description": "Bad Request: message is too long"
                    }),
                    ("sendmessage", true) => serde_json::json!({"ok": true, "result": {
                        "message_id": 2, "date": 0, "text": "short",
                        "chat": {"id": -100, "title": "g", "type": "supergroup"}
                    }}),
                    _ => serde_json::json!({"ok": true, "result": true}),
                })
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, api).await });
        let bot = teloxide::Bot::new("1:test").set_api_url(url.parse().unwrap());
        let msg: teloxide::types::Message = serde_json::from_value(serde_json::json!({
            "message_id": 1, "date": 0, "text": "long",
            "chat": {"id": -100, "title": "g", "type": "supergroup"},
            "from": {"id": 42, "is_bot": false, "first_name": "A"}
        }))
        .unwrap();
        let plan = LinkPlan {
            admin: vec![LinkReply::text("long")],
            reply: vec![LinkReply::text("short")],
        };
        deliver_link_plan(&bot, &msg, true, "test", plan)
            .await
            .unwrap();
        assert_eq!(
            *calls.lock().unwrap(),
            [
                ("sendmessage".to_string(), false),
                ("sendmessage".to_string(), true)
            ]
        );
    }

    #[tokio::test]
    async fn a_partly_posted_admin_repost_is_not_repeated_as_replies() {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let seen = calls.clone();
        let api = axum::Router::new().fallback(move |uri: axum::http::Uri, body: String| {
            let seen = seen.clone();
            async move {
                let method = uri
                    .path()
                    .rsplit('/')
                    .next()
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let second = body.contains("second");
                seen.lock().unwrap().push((method, second));
                axum::Json(if second {
                    serde_json::json!({
                        "ok": false, "error_code": 400, "description": "Bad Request: IMAGE_PROCESS_FAILED"
                    })
                } else {
                    serde_json::json!({"ok": true, "result": {
                        "message_id": 2, "date": 0, "text": "first",
                        "chat": {"id": -100, "title": "g", "type": "supergroup"}
                    }})
                })
            }
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/", listener.local_addr().unwrap());
        tokio::spawn(async move { axum::serve(listener, api).await });
        let bot = teloxide::Bot::new("1:test").set_api_url(url.parse().unwrap());
        let msg: teloxide::types::Message = serde_json::from_value(serde_json::json!({
            "message_id": 1, "date": 0, "text": "links",
            "chat": {"id": -100, "title": "g", "type": "supergroup"},
            "from": {"id": 42, "is_bot": false, "first_name": "A"}
        }))
        .unwrap();
        let plan = LinkPlan {
            admin: vec![LinkReply::text("first"), LinkReply::text("second")],
            reply: vec![LinkReply::text("first"), LinkReply::text("second")],
        };
        assert!(
            deliver_link_plan(&bot, &msg, true, "test", plan)
                .await
                .is_ok()
        );
        assert_eq!(
            *calls.lock().unwrap(),
            [
                ("sendmessage".to_string(), false),
                ("sendmessage".to_string(), true)
            ]
        );
    }
}
