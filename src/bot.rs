use std::time::Instant;

use anyhow::Result;
use log::error;
use reqwest::Url;
use teloxide::dispatching::UpdateFilterExt;
use teloxide::filter_command;
use teloxide::prelude::*;
use teloxide::types::{
    CallbackQuery, ChatKind, InlineKeyboardButton, InlineKeyboardMarkup, Message, ParseMode,
    PublicChatKind,
};
use teloxide::utils::{command::BotCommands, html};

use crate::hitomi::{GalleryClient, GalleryInfo};
use crate::urlchanger;

pub type HandlerResult = Result<()>;

#[derive(Clone)]
pub struct AppState {
    pub bot_username: String,
    pub gallery_client: GalleryClient,
}

impl AppState {
    pub fn new(bot_username: String, gallery_client: GalleryClient) -> Self {
        Self {
            bot_username,
            gallery_client,
        }
    }
}

#[derive(BotCommands, Clone)]
#[command(rename_rule = "lowercase", description = "사용 가능한 명령어")]
enum Command {
    #[command(description = "봇 사용법 안내")]
    Start,
    #[command(description = "봇 상태 확인")]
    Ping,
}

pub async fn run<B>(bot: B, state: AppState) -> Result<()>
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: Send + Sync + 'static,
    <B as Requester>::GetUpdates: Send,
    <B as Requester>::GetChatMember: Send,
{
    bot.set_my_commands(Command::bot_commands()).await?;

    let handler = dptree::entry()
        .branch(
            Update::filter_message()
                .branch(filter_command::<Command, _>().endpoint(handle_command::<B>))
                .branch(urlchanger::url_handlers::<B>())
                .branch(dptree::endpoint(handle_message::<B>)),
        )
        .branch(Update::filter_callback_query().endpoint(handle_callback::<B>));

    Dispatcher::builder(bot, handler)
        .dependencies(dptree::deps![state])
        .enable_ctrlc_handler()
        .default_handler(|_| async move {})
        .build()
        .dispatch()
        .await;

    Ok(())
}

async fn handle_command<B>(bot: B, msg: Message, cmd: Command, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: Send + Sync + 'static,
{
    match cmd {
        Command::Start => {
            let mut text = String::from(
                "선생님, 반갑습니다. 저는 선생님의 Hitomi.la 갤러리 정보 검색 요청을 지원하는 Bot, 프라나입니다.\n\n명령어 프로토콜 안내\n- 개인 채널: 숫자 ID 직접 입력 (예시: 12345)\n- 모든 채널: 접두사 !와 ID 입력 (예시: !12345)\n",
            );

            if state.bot_username.is_empty() {
                text.push_str("- 그룹 채널: 저를 호출 후 ID 입력 (예시: @봇이름 12345)\n");
            } else {
                text.push_str(&format!(
                    "- 그룹 채널: 저를 호출(@{}) 후 ID 입력 (예시: @{} 12345)\n",
                    state.bot_username, state.bot_username
                ));
            }

            text.push_str("\n분석이 필요한 ID를 입력해주십시오, 선생님.");

            bot.send_message(msg.chat.id, html::escape(&text))
                .parse_mode(ParseMode::Html)
                .await?;
        }
        Command::Ping => {
            let started = Instant::now();
            let elapsed = started.elapsed();
            let ms = elapsed.as_secs_f64() * 1000.0;

            bot.send_message(
                msg.chat.id,
                format!("Pong..? 입니다, 선생님.\n{:.6} ms", ms),
            )
            .await?;
        }
    }

    Ok(())
}

async fn handle_message<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: Send + Sync + 'static,
{
    let text = match msg.text() {
        Some(t) => t.trim(),
        None => return Ok(()),
    };

    let Some(gallery_id) = extract_gallery_id(text, &msg, &state.bot_username) else {
        return Ok(());
    };

    let chat_id = msg.chat.id;
    let initial = bot
        .send_message(
            chat_id,
            format!(
                "선생님, 요청하신 ID {}에 대한 데이터 검색을 시작합니다. 잠시만 기다려주십시오...",
                gallery_id
            ),
        )
        .reply_to_message_id(msg.id)
        .disable_notification(true)
        .await?;

    let info = state.gallery_client.get_gallery_info(&gallery_id).await?;

    match info {
        Some(info) => {
            let response = render_gallery_message(&info, false);
            let keyboard = build_gallery_keyboard(&info, !is_private_chat(&msg));

            if let Err(err) = bot
                .edit_message_text(chat_id, initial.id, response)
                .parse_mode(ParseMode::Html)
                .reply_markup(keyboard)
                .await
            {
                error!("메시지 수정 실패 (ID {}): {}", gallery_id, err);
            }
        }
        None => {
            let error_text = format!(
                "선생님, ID {}에 대한 정보를 찾을 수 없거나, 제목 데이터가 누락된 것으로 확인됩니다.",
                gallery_id
            );

            if let Err(err) = bot.edit_message_text(chat_id, initial.id, error_text).await {
                error!("오류 메시지 수정 실패 (ID {}): {}", gallery_id, err);
            }
        }
    }

    Ok(())
}

async fn handle_callback<B>(bot: B, query: CallbackQuery, state: AppState) -> HandlerResult
where
    B: Requester + Send + Sync + 'static,
    B::Err: Send + Sync + 'static,
{
    let Some(data) = query.data.clone() else {
        bot.answer_callback_query(query.id).await?;
        return Ok(());
    };

    if let Some(gallery_id) = data.strip_prefix("save_") {
        let info = state.gallery_client.get_gallery_info(gallery_id).await?;

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
                        .text("선생님, 먼저 저와 개인 대화를 시작하거나 차단을 해제해 주세요.")
                        .show_alert(true)
                        .await;
                } else {
                    let _ = bot
                        .answer_callback_query(query.id)
                        .text("갤러리 정보가 저와 선생님의 메시지로 전송되었습니다.")
                        .await;
                }
            }
            None => {
                let _ = bot
                    .answer_callback_query(query.id)
                    .text("저장할 갤러리 정보를 찾지 못했습니다.")
                    .show_alert(true)
                    .await;
            }
        }
    } else {
        bot.answer_callback_query(query.id).await?;
    }

    Ok(())
}

fn extract_gallery_id(text: &str, msg: &Message, bot_username: &str) -> Option<String> {
    static BANG_RE: once_cell::sync::Lazy<regex::Regex> =
        once_cell::sync::Lazy::new(|| regex::Regex::new(r"^!(\d+)$").unwrap());

    if let Some(cap) = BANG_RE.captures(text) {
        return Some(cap[1].to_string());
    }

    match &msg.chat.kind {
        ChatKind::Private(_) => {
            if text.chars().all(|c| c.is_ascii_digit()) {
                return Some(text.to_string());
            }
        }
        ChatKind::Public(public) => match &public.kind {
            PublicChatKind::Group(_) | PublicChatKind::Supergroup(_) => {
                if bot_username.is_empty() {
                    return None;
                }

                let pattern = format!(r"^@{}\s+(\d+)", regex::escape(bot_username));
                if let Ok(re) = regex::Regex::new(&pattern) {
                    if let Some(cap) = re.captures(text) {
                        return Some(cap[1].to_string());
                    }
                }
            }
            _ => {}
        },
    }

    None
}

fn render_gallery_message(info: &GalleryInfo, saved: bool) -> String {
    let title = html::escape(&info.title);
    let artists = html::escape(&info.artists);
    let language = html::escape(&info.language);
    let tags = if info.tags.is_empty() {
        "태그 정보 없음".to_string()
    } else {
        info.tags
            .iter()
            .map(|t| html::escape(t))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let header = if saved {
        format!(
            "<b>선생님, ID {}에 대한 분석 결과입니다. (#저장됨)</b>",
            info.id
        )
    } else {
        format!("<b>선생님, ID {}에 대한 분석 결과입니다.</b>", info.id)
    };

    format!(
        "{header}\n\n<b>제목:</b> {title}\n<b>작가:</b> {artists}\n<b>언어:</b> {language}\n<b>태그:</b> {tags}"
    )
}

fn build_gallery_keyboard(info: &GalleryInfo, include_save: bool) -> InlineKeyboardMarkup {
    let hitomi = Url::parse(&info.hitomi_url()).expect("hitomi url should be valid");
    let k_hentai = Url::parse(&info.k_hentai_url()).expect("k-hentai url should be valid");

    let mut rows = vec![
        vec![InlineKeyboardButton::url("Hitomi.la에서 보기", hitomi)],
        vec![InlineKeyboardButton::url("K-Hentai에서 보기", k_hentai)],
    ];

    if include_save {
        rows.push(vec![InlineKeyboardButton::callback(
            "저장: 제 개인 메시지로 보내기",
            format!("save_{}", info.id),
        )]);
    }

    InlineKeyboardMarkup::new(rows)
}

fn is_private_chat(msg: &Message) -> bool {
    matches!(msg.chat.kind, ChatKind::Private(_))
}
