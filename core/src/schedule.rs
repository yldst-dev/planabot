use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::Result;
use chrono::{FixedOffset, TimeZone};
use log::{error, info, warn};
use regex::Regex;
use serde::{Deserialize, Serialize};
use teloxide::prelude::*;
use teloxide::types::{ChatId, MessageId, ParseMode, ReplyParameters, ThreadId};
use teloxide::utils::html;
use tokio::fs;
use tokio::time::{self, Duration};

const MAX_SCHEDULE_ITEMS: usize = 500;
const MAX_USER_PENDING_ITEMS: usize = 100;
const SCHEDULE_POLL_SECONDS: u64 = 15;
const DEFAULT_SCHEDULE_TITLE: &str = "요청하신 내용";

static SCHEDULE_ID_SEQ: AtomicU64 = AtomicU64::new(1);
static TITLE_COMMAND_PREFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(?:(?:프라나야|프라나)\s*)?(?:(?:알려\s*줘|알려\s*주세요|알림|타이머|리마인더|리마인드|예약|등록|추가|생성|설정|맞춰)(?:\s*(?:해줘|해주세요|해|줘))?\s*)+")
        .expect("title command prefix regex should be valid")
});
static TITLE_COMMAND_SUFFIX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\s*(?:(?:알려\s*줘|알려\s*주세요|알림|타이머|리마인더|리마인드|예약|등록|추가|생성|설정|맞춰)(?:\s*(?:해줘|해주세요|해|줘))?|(?:해줘|해주세요|부탁|줘))+$")
        .expect("title command suffix regex should be valid")
});

#[derive(Clone)]
pub(crate) struct ScheduleStore {
    path: PathBuf,
    items: Arc<Mutex<Vec<ScheduleItem>>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScheduleKind {
    Schedule,
    Timer,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ScheduleStatus {
    Pending,
    Sending,
    Sent,
    Canceled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ScheduleItem {
    pub id: String,
    pub owner_user_id: u64,
    pub chat_id: i64,
    pub message_thread_id: Option<ThreadId>,
    pub source_message_id: Option<MessageId>,
    pub kind: ScheduleKind,
    pub title: String,
    pub due_at_ms: i64,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub status: ScheduleStatus,
    pub sent_at_ms: Option<i64>,
    pub canceled_at_ms: Option<i64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct NewSchedule {
    pub owner_user_id: u64,
    pub chat_id: ChatId,
    pub message_thread_id: Option<ThreadId>,
    pub source_message_id: Option<MessageId>,
    pub kind: ScheduleKind,
    pub title: String,
    pub due_at_ms: i64,
}

#[derive(Debug, Clone)]
pub(crate) struct ScheduleMutation {
    pub ok: bool,
    pub item: Option<ScheduleItem>,
    pub items: Vec<ScheduleItem>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct ScheduleFile {
    items: Vec<ScheduleItem>,
}

impl ScheduleStore {
    pub(crate) fn new() -> Self {
        let path = resolve_schedule_path();
        let items = load_schedule_items(&path);
        Self {
            path,
            items: Arc::new(Mutex::new(items)),
        }
    }

    pub(crate) async fn add(&self, input: NewSchedule) -> Result<ScheduleMutation> {
        let now = now_ms();
        let mut title = normalize_title(&input.title);
        if title.is_empty() {
            title = default_schedule_title().to_string();
        }
        if input.due_at_ms <= now {
            return Ok(
                self.mutation_error(input.owner_user_id, "현재 이후 시각만 등록할 수 있습니다.")
            );
        }

        let (item, items, snapshot) = {
            let mut items = lock_items(&self.items);
            prune_history(&mut items, now);
            let user_pending_count = items
                .iter()
                .filter(|item| {
                    item.owner_user_id == input.owner_user_id
                        && item.status == ScheduleStatus::Pending
                })
                .count();
            if user_pending_count >= MAX_USER_PENDING_ITEMS {
                let visible = list_pending_for_user(&items, input.owner_user_id);
                return Ok(ScheduleMutation {
                    ok: false,
                    item: None,
                    items: visible,
                    error: Some("등록 가능한 항목 수를 초과했습니다.".to_string()),
                });
            }

            let item = ScheduleItem {
                id: create_schedule_id(),
                owner_user_id: input.owner_user_id,
                chat_id: input.chat_id.0,
                message_thread_id: input.message_thread_id,
                source_message_id: input.source_message_id,
                kind: input.kind,
                title,
                due_at_ms: input.due_at_ms,
                created_at_ms: now,
                updated_at_ms: now,
                status: ScheduleStatus::Pending,
                sent_at_ms: None,
                canceled_at_ms: None,
                last_error: None,
            };
            items.push(item.clone());
            sort_items(&mut items);
            let visible = list_pending_for_user(&items, item.owner_user_id);
            (item, visible, items.clone())
        };

        self.persist(&snapshot).await?;
        Ok(ScheduleMutation {
            ok: true,
            item: Some(item),
            items,
            error: None,
        })
    }

    pub(crate) fn list_user_pending(&self, owner_user_id: u64) -> Vec<ScheduleItem> {
        let items = lock_items(&self.items);
        list_pending_for_user(&items, owner_user_id)
    }

    pub(crate) async fn cancel(&self, owner_user_id: u64, query: &str) -> Result<ScheduleMutation> {
        let now = now_ms();
        let (result, snapshot) = {
            let mut items = lock_items(&self.items);
            let pending = list_pending_for_user(&items, owner_user_id);
            let Some(target) = find_schedule_match(&pending, query) else {
                let visible = list_pending_for_user(&items, owner_user_id);
                return Ok(ScheduleMutation {
                    ok: false,
                    item: None,
                    items: visible,
                    error: Some("대상 항목을 찾지 못했습니다.".to_string()),
                });
            };
            let mut changed = None;
            for item in items.iter_mut() {
                if item.id == target.id {
                    item.status = ScheduleStatus::Canceled;
                    item.updated_at_ms = now;
                    item.canceled_at_ms = Some(now);
                    changed = Some(item.clone());
                    break;
                }
            }
            sort_items(&mut items);
            let visible = list_pending_for_user(&items, owner_user_id);
            (
                ScheduleMutation {
                    ok: true,
                    item: changed,
                    items: visible,
                    error: None,
                },
                items.clone(),
            )
        };

        self.persist(&snapshot).await?;
        Ok(result)
    }

    async fn claim_due(&self, now: i64) -> Result<Vec<ScheduleItem>> {
        let (due, snapshot) = {
            let mut items = lock_items(&self.items);
            let mut due = Vec::new();
            for item in items.iter_mut() {
                if item.status == ScheduleStatus::Pending && item.due_at_ms <= now {
                    item.status = ScheduleStatus::Sending;
                    item.updated_at_ms = now;
                    item.last_error = None;
                    due.push(item.clone());
                }
            }
            (due, items.clone())
        };

        if !due.is_empty() {
            self.persist(&snapshot).await?;
        }
        Ok(due)
    }

    async fn mark_sent(&self, id: &str) -> Result<()> {
        let now = now_ms();
        let snapshot = {
            let mut items = lock_items(&self.items);
            for item in items.iter_mut() {
                if item.id == id {
                    item.status = ScheduleStatus::Sent;
                    item.sent_at_ms = Some(now);
                    item.updated_at_ms = now;
                    item.last_error = None;
                    break;
                }
            }
            items.clone()
        };
        self.persist(&snapshot).await
    }

    async fn mark_failed(&self, id: &str, error: &str) -> Result<()> {
        let now = now_ms();
        let snapshot = {
            let mut items = lock_items(&self.items);
            for item in items.iter_mut() {
                if item.id == id {
                    item.status = ScheduleStatus::Failed;
                    item.updated_at_ms = now;
                    item.last_error = Some(error.trim().chars().take(500).collect());
                    break;
                }
            }
            items.clone()
        };
        self.persist(&snapshot).await
    }

    fn mutation_error(&self, owner_user_id: u64, error: &str) -> ScheduleMutation {
        ScheduleMutation {
            ok: false,
            item: None,
            items: self.list_user_pending(owner_user_id),
            error: Some(error.to_string()),
        }
    }

    async fn persist(&self, items: &[ScheduleItem]) -> Result<()> {
        persist_schedule_items(&self.path, items).await
    }
}

pub(crate) fn spawn_schedule_worker<B>(bot: B, store: ScheduleStore)
where
    B: Requester + Clone + Send + Sync + 'static,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendMessage: Send,
{
    tokio::spawn(async move {
        let mut interval = time::interval(Duration::from_secs(SCHEDULE_POLL_SECONDS));
        loop {
            interval.tick().await;
            let due = match store.claim_due(now_ms()).await {
                Ok(due) => due,
                Err(err) => {
                    error!("일정 조회 실패: {}", err);
                    continue;
                }
            };
            for item in due {
                let text = render_due_message(&item);
                let result = send_scheduled_message(&bot, &item, text).await;
                match result {
                    Ok(()) => {
                        if let Err(err) = store.mark_sent(&item.id).await {
                            error!("일정 발송 상태 저장 실패 ({}): {}", item.id, err);
                        } else {
                            info!("일정 발송 완료: {}", item.id);
                        }
                    }
                    Err(err) => {
                        warn!("일정 발송 실패 ({}): {}", item.id, err);
                        if let Err(save_err) = store.mark_failed(&item.id, &err.to_string()).await {
                            error!("일정 실패 상태 저장 실패 ({}): {}", item.id, save_err);
                        }
                    }
                }
            }
        }
    });
}

pub(crate) fn render_schedule_list(items: &[ScheduleItem]) -> String {
    if items.is_empty() {
        return "일정 확인.\n선생님.\n등록된 항목이 없습니다.".to_string();
    }

    let lines = items
        .iter()
        .enumerate()
        .map(|(idx, item)| {
            format!(
                "{}. [{}] {} - {}",
                idx + 1,
                render_kind(&item.kind),
                format_kst(item.due_at_ms),
                item.title
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!("일정 확인.\n선생님.\n예정된 항목입니다.\n\n{lines}")
}

pub(crate) fn render_schedule_add_result(result: &ScheduleMutation) -> String {
    if let (true, Some(item)) = (result.ok, result.item.as_ref()) {
        return format!(
            "등록 완료.\n선생님.\n{}에 알려드리겠습니다.\n\n{}",
            format_kst(item.due_at_ms),
            render_schedule_list(&result.items)
        );
    }
    format!(
        "확인 불가.\n선생님.\n{}\n\n{}",
        result
            .error
            .as_deref()
            .unwrap_or("작업을 처리하지 못했습니다."),
        render_schedule_list(&result.items)
    )
}

pub(crate) fn render_schedule_cancel_result(result: &ScheduleMutation) -> String {
    if result.ok {
        return format!(
            "취소 완료.\n선생님.\n\n{}",
            render_schedule_list(&result.items)
        );
    }
    format!(
        "확인 불가.\n선생님.\n{}\n\n{}",
        result
            .error
            .as_deref()
            .unwrap_or("작업을 처리하지 못했습니다."),
        render_schedule_list(&result.items)
    )
}

pub(crate) fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

fn render_due_message(item: &ScheduleItem) -> String {
    let owner = format!("<a href=\"tg://user?id={}\">선생님</a>", item.owner_user_id);
    let title = html::escape(&item.title);
    match item.kind {
        ScheduleKind::Schedule => format!("알림.\n{owner}.\n{title}"),
        ScheduleKind::Timer => format!("타이머 완료.\n{owner}.\n{title}"),
    }
}

async fn send_scheduled_message<B>(bot: &B, item: &ScheduleItem, text: String) -> Result<()>
where
    B: Requester + ?Sized,
    B::Err: std::error::Error + Send + Sync + 'static,
    B::SendMessage: Send,
{
    let chat_id = ChatId(item.chat_id);
    let mut req = bot.send_message(chat_id, text.clone());
    req = req.parse_mode(ParseMode::Html);
    if let Some(thread_id) = item.message_thread_id {
        req = req.message_thread_id(thread_id);
    }
    if let Some(message_id) = item.source_message_id {
        req = req.reply_parameters(ReplyParameters::new(message_id).allow_sending_without_reply());
    }
    match req.await {
        Ok(_) => Ok(()),
        Err(err) => {
            let err_text = err.to_string().to_lowercase();
            if err_text.contains("message thread not found") {
                bot.send_message(chat_id, text)
                    .parse_mode(ParseMode::Html)
                    .await?;
                Ok(())
            } else if err_text.contains("message to be replied not found") {
                let mut fallback = bot.send_message(chat_id, text).parse_mode(ParseMode::Html);
                if let Some(thread_id) = item.message_thread_id {
                    fallback = fallback.message_thread_id(thread_id);
                }
                fallback.await?;
                Ok(())
            } else {
                Err(err.into())
            }
        }
    }
}

fn resolve_schedule_path() -> PathBuf {
    let raw = std::env::var("PLANABOT_SCHEDULES_PATH")
        .unwrap_or_else(|_| ".planabot/schedules.json".to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn load_schedule_items(path: &Path) -> Vec<ScheduleItem> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return Vec::new();
    };
    let parsed = serde_json::from_str::<ScheduleFile>(&raw)
        .map(|file| file.items)
        .or_else(|_| serde_json::from_str::<Vec<ScheduleItem>>(&raw))
        .unwrap_or_default();
    let now = now_ms();
    let mut items = normalize_items(parsed, now);
    prune_history(&mut items, now);
    sort_items(&mut items);
    items
}

async fn persist_schedule_items(path: &Path, items: &[ScheduleItem]) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let payload = serde_json::json!({
        "version": 1,
        "items": items,
    });
    let text = serde_json::to_string_pretty(&payload)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).await?;
    fs::rename(tmp, path).await?;
    Ok(())
}

fn normalize_items(items: Vec<ScheduleItem>, now: i64) -> Vec<ScheduleItem> {
    items
        .into_iter()
        .filter_map(|mut item| {
            item.title = normalize_title(&item.title);
            if item.id.trim().is_empty()
                || item.title.is_empty()
                || item.owner_user_id == 0
                || item.chat_id == 0
                || item.due_at_ms <= 0
            {
                return None;
            }
            if item.status == ScheduleStatus::Sending {
                item.status = ScheduleStatus::Pending;
                item.updated_at_ms = now;
            }
            Some(item)
        })
        .collect()
}

fn prune_history(items: &mut Vec<ScheduleItem>, now: i64) {
    let cutoff = now - 30 * 24 * 60 * 60 * 1000;
    items.retain(|item| {
        item.status == ScheduleStatus::Pending
            || item.status == ScheduleStatus::Sending
            || item.updated_at_ms >= cutoff
    });
    if items.len() > MAX_SCHEDULE_ITEMS {
        sort_items(items);
        let overflow = items.len() - MAX_SCHEDULE_ITEMS;
        items.drain(0..overflow);
    }
}

fn list_pending_for_user(items: &[ScheduleItem], owner_user_id: u64) -> Vec<ScheduleItem> {
    let mut out = items
        .iter()
        .filter(|item| {
            item.owner_user_id == owner_user_id && item.status == ScheduleStatus::Pending
        })
        .cloned()
        .collect::<Vec<_>>();
    sort_items(&mut out);
    out
}

fn find_schedule_match(items: &[ScheduleItem], query: &str) -> Option<ScheduleItem> {
    let normalized = normalize_match_text(query);
    if let Some(index) = parse_selector_index(&normalized, items.len()) {
        return items.get(index).cloned();
    }
    if normalized.is_empty() {
        return None;
    }
    items
        .iter()
        .find(|item| normalize_match_text(&item.id) == normalized)
        .or_else(|| {
            items
                .iter()
                .find(|item| normalize_match_text(&item.id).starts_with(&normalized))
        })
        .or_else(|| {
            items
                .iter()
                .find(|item| normalize_match_text(&item.title) == normalized)
        })
        .or_else(|| {
            items
                .iter()
                .find(|item| normalize_match_text(&item.title).contains(&normalized))
        })
        .or_else(|| {
            items
                .iter()
                .find(|item| normalized.contains(&normalize_match_text(&item.title)))
        })
        .cloned()
}

fn parse_selector_index(value: &str, item_count: usize) -> Option<usize> {
    if item_count == 0 || value.is_empty() {
        return None;
    }
    if matches!(
        value,
        "마지막" | "마지막거" | "마지막것" | "마지막꺼" | "마지막항목" | "맨마지막" | "맨마지막거"
    ) {
        return Some(item_count - 1);
    }
    if let Ok(number) = value
        .trim_end_matches("번째")
        .trim_end_matches("째")
        .trim_end_matches("번")
        .trim_end_matches("거")
        .trim_end_matches("것")
        .trim_end_matches("꺼")
        .trim_end_matches("항목")
        .parse::<usize>()
    {
        let index = number.saturating_sub(1);
        return (index < item_count).then_some(index);
    }
    let ordinals: [&[&str]; 10] = [
        &[
            "첫",
            "첫번",
            "첫번째",
            "첫째",
            "처음",
            "맨위",
            "맨첫",
            "일번",
            "일번째",
        ],
        &["두", "두번", "두번째", "둘째", "이번", "이번째"],
        &["세", "세번", "세번째", "셋째", "삼번", "삼번째"],
        &["네", "네번", "네번째", "넷째", "사번", "사번째"],
        &["다섯", "다섯번", "다섯번째", "오번", "오번째"],
        &["여섯", "여섯번", "여섯번째", "육번", "육번째"],
        &["일곱", "일곱번", "일곱번째", "칠번", "칠번째"],
        &["여덟", "여덟번", "여덟번째", "팔번", "팔번째"],
        &["아홉", "아홉번", "아홉번째", "구번", "구번째"],
        &["열", "열번", "열번째", "십번", "십번째"],
    ];
    ordinals
        .iter()
        .position(|words| {
            words.iter().any(|word| {
                value == *word
                    || value == format!("{word}거")
                    || value == format!("{word}것")
                    || value == format!("{word}꺼")
                    || value == format!("{word}항목")
            })
        })
        .filter(|index| *index < item_count)
}

fn sort_items(items: &mut [ScheduleItem]) {
    items.sort_by(|a, b| {
        a.due_at_ms
            .cmp(&b.due_at_ms)
            .then_with(|| a.created_at_ms.cmp(&b.created_at_ms))
            .then_with(|| a.id.cmp(&b.id))
    });
}

fn lock_items(
    items: &Arc<Mutex<Vec<ScheduleItem>>>,
) -> std::sync::MutexGuard<'_, Vec<ScheduleItem>> {
    match items.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

fn create_schedule_id() -> String {
    let now = now_ms().max(0) as u64;
    let seq = SCHEDULE_ID_SEQ.fetch_add(1, Ordering::Relaxed);
    format!("s{now:x}{seq:x}")
}

fn normalize_title(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    strip_title_commands(&compact).chars().take(500).collect()
}

fn default_schedule_title() -> &'static str {
    DEFAULT_SCHEDULE_TITLE
}

fn strip_title_commands(value: &str) -> String {
    let mut text = value.trim().to_string();
    loop {
        let next = TITLE_COMMAND_SUFFIX
            .replace(&TITLE_COMMAND_PREFIX.replace(&text, " "), " ")
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if next == text {
            return next;
        }
        text = next;
    }
}

fn normalize_match_text(value: &str) -> String {
    value
        .to_lowercase()
        .chars()
        .map(|ch| {
            if ch.is_ascii_punctuation()
                || matches!(
                    ch,
                    '。' | '？' | '！' | '：' | 'ㆍ' | '·' | '“' | '”' | '‘' | '’'
                )
            {
                ' '
            } else {
                ch
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn render_kind(kind: &ScheduleKind) -> &'static str {
    match kind {
        ScheduleKind::Schedule => "일정",
        ScheduleKind::Timer => "타이머",
    }
}

fn format_kst(timestamp_ms: i64) -> String {
    let offset = FixedOffset::east_opt(9 * 3600).expect("KST offset should be valid");
    let seconds = timestamp_ms.div_euclid(1000);
    let millis = timestamp_ms.rem_euclid(1000) as u32;
    let nanos = millis * 1_000_000;
    offset
        .timestamp_opt(seconds, nanos)
        .single()
        .map(|dt| dt.format("%Y-%m-%d %H:%M KST").to_string())
        .unwrap_or_else(|| "시각 확인 불가".to_string())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use super::{
        NewSchedule, ScheduleKind, ScheduleStore, find_schedule_match, list_pending_for_user,
        normalize_title, now_ms,
    };
    use teloxide::types::ChatId;

    #[test]
    fn selector_finds_first_schedule() {
        let mut items = Vec::new();
        items.push(super::ScheduleItem {
            id: "a".to_string(),
            owner_user_id: 1,
            chat_id: 10,
            message_thread_id: None,
            source_message_id: None,
            kind: ScheduleKind::Schedule,
            title: "첫 일정".to_string(),
            due_at_ms: now_ms() + 1000,
            created_at_ms: now_ms(),
            updated_at_ms: now_ms(),
            status: super::ScheduleStatus::Pending,
            sent_at_ms: None,
            canceled_at_ms: None,
            last_error: None,
        });
        items.push(super::ScheduleItem {
            id: "b".to_string(),
            owner_user_id: 1,
            chat_id: 10,
            message_thread_id: None,
            source_message_id: None,
            kind: ScheduleKind::Timer,
            title: "두 번째".to_string(),
            due_at_ms: now_ms() + 2000,
            created_at_ms: now_ms(),
            updated_at_ms: now_ms(),
            status: super::ScheduleStatus::Pending,
            sent_at_ms: None,
            canceled_at_ms: None,
            last_error: None,
        });
        let pending = list_pending_for_user(&items, 1);
        let item = find_schedule_match(&pending, "첫번째거").unwrap();
        assert_eq!(item.id, "a");
    }

    #[tokio::test]
    async fn add_rejects_past_due_time() {
        let store = ScheduleStore {
            path: std::env::temp_dir().join(format!("planabot_schedule_test_{}.json", now_ms())),
            items: Arc::new(Mutex::new(Vec::new())),
        };
        let result = store
            .add(NewSchedule {
                owner_user_id: 1,
                chat_id: ChatId(10),
                message_thread_id: None,
                source_message_id: None,
                kind: ScheduleKind::Schedule,
                title: "지난 일정".to_string(),
                due_at_ms: now_ms() - 1000,
            })
            .await
            .unwrap();
        assert!(!result.ok);
        let _ = std::fs::remove_file(store.path);
    }

    #[test]
    fn normalize_title_removes_schedule_commands() {
        assert_eq!(normalize_title("알려줘 라면먹을거야"), "라면먹을거야");
        assert_eq!(normalize_title("라면먹을거야 알려줘"), "라면먹을거야");
        assert_eq!(
            normalize_title("프라나야 알려줘 라면먹을거야"),
            "라면먹을거야"
        );
    }

    #[tokio::test]
    async fn add_uses_default_title_when_command_only() {
        let store = ScheduleStore {
            path: std::env::temp_dir().join(format!("planabot_schedule_test_{}.json", now_ms())),
            items: Arc::new(Mutex::new(Vec::new())),
        };
        let result = store
            .add(NewSchedule {
                owner_user_id: 1,
                chat_id: ChatId(10),
                message_thread_id: None,
                source_message_id: None,
                kind: ScheduleKind::Timer,
                title: "알려줘".to_string(),
                due_at_ms: now_ms() + 1000,
            })
            .await
            .unwrap();
        assert!(result.ok);
        assert_eq!(result.item.unwrap().title, "요청하신 내용");
        let _ = std::fs::remove_file(store.path);
    }
}
