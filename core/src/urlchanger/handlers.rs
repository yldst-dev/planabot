use crate::bot::{AppState, HandlerResult};
use crate::urlchanger::delivery::{LinkPlan, LinkReply, deliver_link_plan};
use crate::urlchanger::google_share::resolve_google_share_link;
use crate::urlchanger::instagram::{InstagramMedia, InstagramMediaKind, fetch_instagram_media};
use crate::urlchanger::link_utils::{
    LinkConversion, MusicLink, MusicPlatform, contains_google_share_link, contains_instagram_link,
    contains_music_link, contains_threads_link, contains_x_link, convert_instagram_links,
    convert_threads_links, convert_x_links, extract_google_share_links, extract_music_links,
};
use crate::urlchanger::music_card::build_music_card;
use chrono::Utc;
use log::{error, warn};
use teloxide::dispatching::DpHandlerDescription;
use teloxide::prelude::*;
use teloxide::types::{InlineKeyboardButton, InlineKeyboardMarkup, InputFile, ParseMode};
use teloxide::utils::html;

const CAPTION_LIMIT: usize = 1024;
const MUSIC_CARD_FILE_NAME: &str = "music_card.png";
const MAX_GOOGLE_SHARE_LINKS: usize = 5;
const MAX_INSTAGRAM_PREVIEWS: usize = 3;

fn is_recent_message(msg: &Message, seconds: i64) -> bool {
    let now = Utc::now().timestamp();
    let msg_time = msg.date.timestamp();
    now - msg_time <= seconds
}

pub fn url_handlers<B>() -> Handler<'static, HandlerResult, DpHandlerDescription>
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetUpdates: Send,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    Update::filter_message().branch(
        dptree::filter(|msg: Message, state: AppState| {
            state.is_after_boot(&msg) && is_recent_message(&msg, 30)
        })
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_music_link(msg.text().unwrap())
            })
            .endpoint(handle_music_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_x_link(msg.text().unwrap())
            })
            .endpoint(handle_x_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_instagram_link(msg.text().unwrap())
            })
            .endpoint(handle_instagram_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_threads_link(msg.text().unwrap())
            })
            .endpoint(handle_threads_links::<B>),
        )
        .branch(
            dptree::filter(|msg: Message| {
                msg.text().is_some() && contains_google_share_link(msg.text().unwrap())
            })
            .endpoint(handle_google_share_links::<B>),
        ),
    )
}

async fn is_privileged<B>(bot: &B, msg: &Message, state: &AppState, label: &str) -> bool
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
{
    match bot.get_chat_member(msg.chat.id, state.bot_user_id).await {
        Ok(member) => member.kind.is_privileged(),
        Err(e) => {
            error!("관리자 권한 확인 중 오류 발생({}): {:?}", label, e);
            false
        }
    }
}

pub async fn handle_music_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = extract_music_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let youtube_only = is_youtube_only(&links);
    let any_tracking = links.iter().any(|link| link.had_tracking);

    if youtube_only && !any_tracking {
        return Ok(());
    }

    let privileged = is_privileged(&bot, &msg, &state, "음악").await;
    let username = display_name(&msg);
    let plan = if youtube_only {
        youtube_plan(&username, &links, any_tracking)
    } else {
        let card = build_music_card(&links).await;
        music_plan(&username, text, &links, card)
    };

    deliver_link_plan(&bot, &msg, privileged, "음악", plan).await
}

fn music_plan(
    username: &str,
    original_text: &str,
    links: &[MusicLink],
    card: Option<Vec<u8>>,
) -> LinkPlan {
    let message = format!(
        "정리 완료.\n선생님.\n{}: {}",
        username,
        build_cleaned_message_text(original_text, links)
    );
    let reply_text = build_cleaned_links_text(links);
    let caption = music_card_caption(username);
    let markup = build_links_keyboard(links);

    let card = card.filter(|_| fits_caption(&caption)).map(music_card_file);
    let admin = match card.clone() {
        Some(file) => LinkReply::photo(file, caption.clone()).with_text_fallback(message),
        None => LinkReply::text(message),
    };
    let reply = match card {
        Some(file) => LinkReply::photo(file, caption).with_text_fallback(reply_text),
        None => LinkReply::text(reply_text),
    };

    LinkPlan {
        admin: vec![admin.with_markup(markup.clone())],
        reply: vec![reply.with_markup(markup)],
    }
}

fn youtube_plan(username: &str, links: &[MusicLink], had_tracking: bool) -> LinkPlan {
    let cleaned_text = youtube_cleaned_text(links);
    let message = if cleaned_text.contains('\n') {
        format!("정리 완료.\n선생님.\n{}:\n{}", username, cleaned_text)
    } else {
        format!("정리 완료.\n선생님.\n{}: {}", username, cleaned_text)
    };
    let reply_text = if had_tracking {
        "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n확인 바랍니다."
    } else {
        "확인 완료.\n선생님.\n유튜브 링크입니다.\n원본 링크 버튼을 제공합니다."
    };
    let markup = build_links_keyboard(links);

    LinkPlan {
        admin: vec![LinkReply::text(message).with_markup(markup.clone())],
        reply: vec![LinkReply::text(reply_text).with_markup(markup)],
    }
}

pub async fn handle_x_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_x_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let privileged = is_privileged(&bot, &msg, &state, "X").await;
    let plan = x_plan(&display_name(&msg), text, &links);
    deliver_link_plan(&bot, &msg, privileged, "X", plan).await
}

fn x_plan(username: &str, original_text: &str, links: &[LinkConversion]) -> LinkPlan {
    let converted_text = replace_converted_links(original_text, links);
    let disable_preview = links.iter().any(|l| l.disable_preview);
    let markup = build_social_keyboard(links);

    LinkPlan {
        admin: vec![
            LinkReply::text(format!(
                "정리 완료.\n선생님.\n{}: {}",
                username, converted_text
            ))
            .with_markup(markup.clone())
            .with_disable_preview(disable_preview),
        ],
        reply: vec![
            LinkReply::text(format!(
                "정리 완료.\n선생님.\n임베드 링크입니다.\n{}",
                converted_text
            ))
            .with_markup(markup)
            .with_disable_preview(disable_preview),
        ],
    }
}

pub async fn handle_instagram_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_instagram_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let previews = load_instagram_previews(&links).await;
    let privileged = is_privileged(&bot, &msg, &state, "Instagram").await;
    let plan = instagram_plan(&display_name(&msg), text, &links, previews);
    deliver_link_plan(&bot, &msg, privileged, "Instagram", plan).await
}

fn instagram_plan(
    username: &str,
    original_text: &str,
    links: &[LinkConversion],
    previews: Vec<(LinkConversion, InstagramMedia)>,
) -> LinkPlan {
    if previews.is_empty() {
        let converted_text = replace_converted_links(original_text, links);
        let markup = build_social_keyboard(links);
        return LinkPlan {
            admin: vec![
                LinkReply::text(format!(
                    "정리 완료.\n선생님.\n{}: {}",
                    username, converted_text
                ))
                .with_markup(markup.clone()),
            ],
            reply: vec![
                LinkReply::text(format!(
                    "정리 완료.\n선생님.\n임베드 링크입니다.\n{}",
                    converted_text
                ))
                .with_markup(markup),
            ],
        };
    }

    let mut admin = Vec::with_capacity(previews.len());
    let mut reply = Vec::with_capacity(previews.len());
    for (link, media) in previews {
        let caption = instagram_caption(media.kind);
        let markup = build_instagram_original_keyboard(&link);
        let kind = media.kind;
        let file = instagram_file(media);
        let build = |file: InputFile| match kind {
            InstagramMediaKind::Video => LinkReply::video(file, caption.clone()),
            InstagramMediaKind::Photo => LinkReply::photo(file, caption.clone()),
        };
        admin.push(build(file.clone()).with_markup(markup.clone()));
        reply.push(build(file).with_markup(markup));
    }

    LinkPlan { admin, reply }
}

pub async fn handle_threads_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = convert_threads_links(text);

    if links.is_empty() {
        return Ok(());
    }

    let privileged = is_privileged(&bot, &msg, &state, "Threads").await;
    let plan = threads_plan(&display_name(&msg), text, &links);
    deliver_link_plan(&bot, &msg, privileged, "Threads", plan).await
}

fn threads_plan(username: &str, original_text: &str, links: &[LinkConversion]) -> LinkPlan {
    let converted_text = replace_converted_links(original_text, links);
    LinkPlan {
        admin: vec![LinkReply::text(format!(
            "정리 완료.\n선생님.\n{}: {}",
            username, converted_text
        ))],
        reply: vec![LinkReply::text(format!(
            "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n{}",
            converted_text
        ))],
    }
}

pub async fn handle_google_share_links<B>(bot: B, msg: Message, state: AppState) -> HandlerResult
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    <B as Requester>::GetChatMember: Send,
    <B as Requester>::DeleteMessage: Send,
    <B as Requester>::SendMessage: Send,
    <B as Requester>::SendPhoto: Send,
    <B as Requester>::SendVideo: Send,
{
    state.record_group_chat(&msg).await;

    let text = msg.text().unwrap_or("");
    let links = resolve_google_share_links(text).await;

    if links.is_empty() {
        return Ok(());
    }

    let privileged = is_privileged(&bot, &msg, &state, "구글 공유").await;
    let plan = google_share_plan(&display_name(&msg), &links);
    deliver_link_plan(&bot, &msg, privileged, "구글 공유", plan).await
}

fn google_share_plan(username: &str, links: &[LinkConversion]) -> LinkPlan {
    let message = google_share_message(username, links);
    LinkPlan {
        admin: vec![LinkReply::text(message.clone()).with_parse_mode(ParseMode::Html)],
        reply: vec![LinkReply::text(message).with_parse_mode(ParseMode::Html)],
    }
}

fn replace_converted_links(original_text: &str, links: &[LinkConversion]) -> String {
    let mut text = original_text.to_string();
    for link in links {
        text = text.replace(&link.original, &link.converted);
    }
    text
}

fn music_card_file(png: Vec<u8>) -> InputFile {
    InputFile::memory(png).file_name(MUSIC_CARD_FILE_NAME)
}

fn music_card_caption(username: &str) -> String {
    format!("정리 완료. 선생님.\n{}:", username)
}

fn fits_caption(text: &str) -> bool {
    text.chars().count() <= CAPTION_LIMIT
}

fn build_cleaned_links_text(links: &[MusicLink]) -> String {
    if links.is_empty() {
        return "확인 완료.\n선생님.\n정리된 링크가 없습니다.".to_string();
    }

    let any_tracking = links.iter().any(|link| link.had_tracking);

    if links.len() == 1 {
        if any_tracking {
            format!(
                "정리 완료.\n선생님.\n추적 파라미터를 제거했습니다.\n{}",
                links[0].cleaned
            )
        } else {
            format!(
                "확인 완료.\n선생님.\n음악 링크입니다.\n{}",
                links[0].cleaned
            )
        }
    } else {
        let mut lines = Vec::with_capacity(links.len() + 3);
        if any_tracking {
            lines.push("정리 완료.".to_string());
            lines.push("선생님.".to_string());
            lines.push("추적 파라미터를 제거했습니다.".to_string());
        } else {
            lines.push("확인 완료.".to_string());
            lines.push("선생님.".to_string());
            lines.push("음악 링크입니다.".to_string());
        }
        lines.extend(links.iter().map(|link| link.cleaned.clone()));
        lines.join("\n")
    }
}

fn build_links_keyboard(links: &[MusicLink]) -> Option<InlineKeyboardMarkup> {
    let mut rows: Vec<Vec<InlineKeyboardButton>> = Vec::new();
    let multi = links.len() > 1;
    let mut current_row: Vec<InlineKeyboardButton> = Vec::new();

    for (idx, link) in links.iter().enumerate() {
        let label = if multi {
            format!("링크 #{}", idx + 1)
        } else {
            "링크".to_string()
        };
        match reqwest::Url::parse(&link.cleaned) {
            Ok(parsed) => {
                current_row.push(InlineKeyboardButton::url(label, parsed));
                if current_row.len() == 2 {
                    rows.push(current_row);
                    current_row = Vec::new();
                }
            }
            Err(e) => warn!("음악 URL 파싱 오류: {}, URL: {}", e, link.cleaned),
        }
    }

    if !current_row.is_empty() {
        rows.push(current_row);
    }

    if rows.is_empty() {
        None
    } else {
        Some(InlineKeyboardMarkup::new(rows))
    }
}

fn build_cleaned_message_text(original: &str, links: &[MusicLink]) -> String {
    let mut text = original.to_string();
    for link in links {
        text = text.replace(&link.original, &link.cleaned);
    }
    text
}

fn youtube_cleaned_text(links: &[MusicLink]) -> String {
    if links.len() == 1 {
        links[0].cleaned.clone()
    } else {
        links
            .iter()
            .map(|link| link.cleaned.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    }
}

fn is_youtube_only(links: &[MusicLink]) -> bool {
    !links.is_empty()
        && links
            .iter()
            .all(|link| link.platform == MusicPlatform::YouTube)
}

async fn load_instagram_previews(
    links: &[LinkConversion],
) -> Vec<(LinkConversion, InstagramMedia)> {
    let mut previews = Vec::new();
    for link in links.iter().take(MAX_INSTAGRAM_PREVIEWS) {
        match fetch_instagram_media(&link.cleaned_original).await {
            Ok(media) => previews.push((link.clone(), media)),
            Err(e) => warn!("Instagram 미리보기 수집 실패: {:?}", e),
        }
    }
    previews
}

fn instagram_caption(kind: InstagramMediaKind) -> String {
    let preview = match kind {
        InstagramMediaKind::Video => "릴스 미리보기를 보내드리겠습니다.",
        InstagramMediaKind::Photo => "미리보기를 보내드리겠습니다.",
    };
    format!("정리 완료. 선생님.\n{preview}")
}

fn build_instagram_original_keyboard(link: &LinkConversion) -> Option<InlineKeyboardMarkup> {
    match reqwest::Url::parse(&link.cleaned_original) {
        Ok(original) => Some(InlineKeyboardMarkup::new(vec![vec![
            InlineKeyboardButton::url("원본", original),
        ]])),
        Err(e) => {
            warn!("원본 URL 파싱 오류: {}, URL: {}", e, link.cleaned_original);
            None
        }
    }
}

fn instagram_file(media: InstagramMedia) -> InputFile {
    InputFile::memory(media.bytes).file_name(media.file_name)
}

async fn resolve_google_share_links(text: &str) -> Vec<LinkConversion> {
    let mut links = Vec::new();
    for original in extract_google_share_links(text)
        .into_iter()
        .take(MAX_GOOGLE_SHARE_LINKS)
    {
        match resolve_google_share_link(&original).await {
            Ok(resolved) => links.push(LinkConversion {
                original,
                converted: resolved.clone(),
                cleaned_original: resolved,
                disable_preview: false,
            }),
            Err(err) => warn!("구글 공유 링크 해석 실패({}): {:#}", original, err),
        }
    }
    links
}

fn google_share_message(username: &str, links: &[LinkConversion]) -> String {
    let multi = links.len() > 1;
    let anchors: Vec<String> = links
        .iter()
        .enumerate()
        .map(|(idx, link)| {
            let label = if multi {
                format!("Link #{}", idx + 1)
            } else {
                "Link".to_string()
            };
            html::link(&link.converted, &label)
        })
        .collect();
    format!(
        "정리 완료. 선생님.\n{}: {}",
        html::escape(username),
        anchors.join(" ")
    )
}

fn build_social_keyboard(links: &[LinkConversion]) -> Option<InlineKeyboardMarkup> {
    let mut rows = Vec::new();
    let multi = links.len() > 1;

    for (idx, link) in links.iter().enumerate() {
        let suffix = if multi {
            format!(" #{}", idx + 1)
        } else {
            String::new()
        };
        let embed = match reqwest::Url::parse(&link.converted) {
            Ok(parsed) => parsed,
            Err(e) => {
                warn!("임베드 URL 파싱 오류: {}, URL: {}", e, link.converted);
                continue;
            }
        };
        let original = match reqwest::Url::parse(&link.cleaned_original) {
            Ok(parsed) => parsed,
            Err(e) => {
                warn!("원본 URL 파싱 오류: {}, URL: {}", e, link.cleaned_original);
                continue;
            }
        };
        rows.push(vec![
            InlineKeyboardButton::url(format!("임베드{}", suffix), embed),
            InlineKeyboardButton::url(format!("원본{}", suffix), original),
        ]);
    }

    if rows.is_empty() {
        None
    } else {
        Some(InlineKeyboardMarkup::new(rows))
    }
}

fn display_name(msg: &Message) -> String {
    if let Some(user) = msg.from.as_ref() {
        if let Some(username) = &user.username {
            username.to_string()
        } else {
            user.first_name.clone()
        }
    } else {
        "Unknown".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::urlchanger::link_utils::{convert_x_links, extract_music_links};

    fn text_of(reply: &LinkReply) -> &str {
        reply.content.text().expect("text reply")
    }

    #[test]
    fn youtube_plan_texts_depend_on_tracking() {
        let links = extract_music_links("https://youtu.be/Vc-ByDGOuQE?si=abc");
        let tracked = youtube_plan("sensei", &links, true);
        assert_eq!(
            text_of(&tracked.admin[0]),
            "정리 완료.\n선생님.\nsensei: https://youtu.be/Vc-ByDGOuQE"
        );
        assert!(text_of(&tracked.reply[0]).contains("추적 파라미터를 제거했습니다."));
        let plain = youtube_plan("sensei", &links, false);
        assert!(text_of(&plain.reply[0]).contains("유튜브 링크입니다."));
        assert!(plain.admin[0].markup.is_some());
    }

    #[test]
    fn music_plan_uses_card_only_when_caption_fits() {
        let links =
            extract_music_links("https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x");
        let with_card = music_plan(
            "sensei",
            "링크 https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT?si=x",
            &links,
            Some(vec![1, 2, 3]),
        );
        assert!(with_card.admin[0].content.text().is_none());
        assert_eq!(
            with_card.admin[0].content.text_fallback(),
            Some(
                "정리 완료.\n선생님.\nsensei: 링크 https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT"
            )
        );
        assert!(
            with_card.reply[0]
                .content
                .text_fallback()
                .unwrap()
                .contains("추적 파라미터를 제거했습니다.")
        );

        let long_name = "x".repeat(CAPTION_LIMIT);
        let too_long = music_plan(&long_name, "q", &links, Some(vec![1]));
        assert!(too_long.admin[0].content.text().is_some());

        let without_card = music_plan("sensei", "q", &links, None);
        assert!(
            without_card.reply[0]
                .content
                .text()
                .unwrap()
                .contains("open.spotify.com")
        );
    }

    #[test]
    fn x_plan_disables_preview_for_dot_prefixed_links() {
        let links = convert_x_links(".https://x.com/user/status/1?s=1");
        let plan = x_plan("sensei", ".https://x.com/user/status/1?s=1", &links);
        assert_eq!(plan.admin[0].disable_preview, Some(true));
        assert_eq!(plan.reply[0].disable_preview, Some(true));
        assert!(text_of(&plan.admin[0]).contains("fxtwitter.com/user/status/1"));
        assert!(text_of(&plan.reply[0]).starts_with("정리 완료.\n선생님.\n임베드 링크입니다."));
    }

    #[test]
    fn google_share_plan_sends_html_links_in_both_modes() {
        let links = vec![LinkConversion {
            original: "https://share.google/abc".into(),
            converted: "https://www.yna.co.kr/view/AKR1".into(),
            cleaned_original: "https://www.yna.co.kr/view/AKR1".into(),
            disable_preview: false,
        }];
        let plan = google_share_plan("sensei", &links);
        for reply in plan.admin.iter().chain(plan.reply.iter()) {
            assert_eq!(reply.parse_mode, Some(ParseMode::Html));
            assert!(
                text_of(reply).contains("<a href=\"https://www.yna.co.kr/view/AKR1\">Link</a>")
            );
        }
    }

    #[test]
    fn instagram_plan_falls_back_to_text_without_previews() {
        let links = convert_instagram_links("https://www.instagram.com/p/abc/?igsh=1");
        let plan = instagram_plan(
            "sensei",
            "https://www.instagram.com/p/abc/?igsh=1",
            &links,
            Vec::new(),
        );
        assert_eq!(plan.admin.len(), 1);
        assert!(text_of(&plan.admin[0]).contains(&links[0].converted));
        assert!(!text_of(&plan.admin[0]).contains("igsh=1"));
        assert!(text_of(&plan.reply[0]).contains("임베드 링크입니다."));
    }
}
