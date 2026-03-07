use anyhow::{Result, anyhow};
use log::warn;
use once_cell::sync::Lazy;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use teloxide::prelude::*;
use teloxide::sugar::request::RequestLinkPreviewExt;
use teloxide::types::{InlineKeyboardMarkup, Message, ParseMode, ReplyParameters, ThreadId};
use teloxide::utils::markdown;

#[derive(Clone, Default)]
pub(crate) struct SendOptions {
    pub reply_markup: Option<InlineKeyboardMarkup>,
    pub disable_preview: Option<bool>,
    pub disable_notification: Option<bool>,
    pub parse_mode: Option<ParseMode>,
}

static TELEGRAM_DRAFT_CLIENT: Lazy<Client> = Lazy::new(Client::new);

#[derive(Clone, Copy, Debug)]
pub(crate) struct PrivateDraftStatus {
    chat_id: i64,
    message_thread_id: Option<ThreadId>,
    draft_id: i32,
    active: bool,
}

#[derive(Debug, Serialize)]
struct SendMessageDraftPayload<'a> {
    chat_id: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_thread_id: Option<ThreadId>,
    draft_id: i32,
    text: &'a str,
}

#[derive(Debug, Deserialize)]
struct TelegramBoolResponse {
    ok: bool,
    result: Option<bool>,
    description: Option<String>,
}

impl PrivateDraftStatus {
    pub(crate) fn from_message(msg: &Message) -> Option<Self> {
        if !is_telegram_draft_enabled() || !msg.chat.is_private() {
            return None;
        }

        let draft_id = if msg.id.0 == 0 { 1 } else { msg.id.0 };
        Some(Self {
            chat_id: msg.chat.id.0,
            message_thread_id: msg.thread_id,
            draft_id,
            active: true,
        })
    }

    pub(crate) async fn send(&mut self, text: &str) -> bool {
        if !self.active {
            return false;
        }

        match send_message_draft(self.chat_id, self.message_thread_id, self.draft_id, text).await {
            Ok(()) => true,
            Err(err) => {
                warn!("sendMessageDraft 실패, typing으로 폴백: {}", err);
                self.active = false;
                false
            }
        }
    }
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
            if is_markdown_error(&err) {
                let escaped = markdown::escape(&text);
                return send_reply_with_fallback(bot, msg, escaped, opts).await;
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

fn is_markdown_error(err: &anyhow::Error) -> bool {
    let text = err.to_string().to_lowercase();
    text.contains("can't parse entities") || text.contains("cannot parse entities")
}

async fn send_message_draft(
    chat_id: i64,
    message_thread_id: Option<ThreadId>,
    draft_id: i32,
    text: &str,
) -> Result<()> {
    let token = std::env::var("TELEGRAM_API_TOKEN")
        .map_err(|_| anyhow!("TELEGRAM_API_TOKEN이 설정되어 있지 않습니다"))?;
    let base_url = std::env::var("TELOXIDE_API_URL")
        .ok()
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| "https://api.telegram.org".to_string());
    let url = format!(
        "{}/bot{}/sendMessageDraft",
        base_url.trim_end_matches('/'),
        token.trim()
    );

    let payload = SendMessageDraftPayload {
        chat_id,
        message_thread_id,
        draft_id,
        text,
    };

    let response = TELEGRAM_DRAFT_CLIENT
        .post(url)
        .json(&payload)
        .send()
        .await?;
    let status = response.status();
    let body = response.text().await?;
    let parsed = serde_json::from_str::<TelegramBoolResponse>(&body).ok();

    if status.is_success()
        && parsed
            .as_ref()
            .is_some_and(|item| item.ok && item.result == Some(true))
    {
        return Ok(());
    }

    let description = parsed
        .and_then(|item| item.description)
        .filter(|raw| !raw.trim().is_empty())
        .unwrap_or_else(|| body.trim().to_string());

    if description.is_empty() {
        Err(anyhow!("sendMessageDraft 호출 실패: HTTP {}", status))
    } else {
        Err(anyhow!(
            "sendMessageDraft 호출 실패: HTTP {}: {}",
            status,
            description
        ))
    }
}

fn is_telegram_draft_enabled() -> bool {
    match std::env::var("PLANABOT_TELEGRAM_DRAFT_ENABLED") {
        Ok(raw) => {
            let normalized = raw.trim().to_ascii_lowercase();
            !(normalized.is_empty()
                || normalized == "0"
                || normalized == "false"
                || normalized == "off"
                || normalized == "no")
        }
        Err(_) => true,
    }
}
