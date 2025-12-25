use std::collections::{HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use log::warn;
use serde::{Deserialize, Serialize};
use teloxide::types::{ChatId, ChatKind, Message, MessageId, PublicChatKind};
use tokio::fs;

use crate::hitomi::GalleryClient;

#[derive(Debug)]
struct PlanabrainReplyTracker {
    max: usize,
    items: VecDeque<(ChatId, MessageId)>,
}

impl PlanabrainReplyTracker {
    fn new(max: usize) -> Self {
        Self {
            max,
            items: VecDeque::new(),
        }
    }

    fn contains(&self, chat_id: ChatId, message_id: MessageId) -> bool {
        self.items
            .iter()
            .any(|(c, m)| *c == chat_id && *m == message_id)
    }

    fn insert(&mut self, chat_id: ChatId, message_id: MessageId) {
        if let Some(pos) = self
            .items
            .iter()
            .position(|(c, m)| *c == chat_id && *m == message_id)
        {
            self.items.remove(pos);
        }

        self.items.push_back((chat_id, message_id));
        while self.items.len() > self.max {
            self.items.pop_front();
        }
    }

    fn from_records(max: usize, records: Vec<PlanabrainReplyRecord>) -> Self {
        let mut items = VecDeque::new();
        for record in records {
            items.push_back((ChatId(record.chat_id), MessageId(record.message_id)));
        }
        while items.len() > max {
            items.pop_front();
        }
        Self { max, items }
    }

    fn records(&self) -> Vec<PlanabrainReplyRecord> {
        self.items
            .iter()
            .map(|(chat_id, message_id)| PlanabrainReplyRecord {
                chat_id: chat_id.0,
                message_id: message_id.0,
            })
            .collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlanabrainReplyRecord {
    chat_id: i64,
    message_id: i32,
}

#[derive(Clone)]
pub struct AppState {
    pub bot_username: String,
    pub gallery_client: GalleryClient,
    booted_at: i64,
    planabrain_replies: Arc<RwLock<PlanabrainReplyTracker>>,
    planabrain_replies_path: PathBuf,
    group_registry: Arc<RwLock<HashSet<ChatId>>>,
    group_registry_path: PathBuf,
}

impl AppState {
    pub fn new(bot_username: String, gallery_client: GalleryClient) -> Self {
        let booted_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let group_registry_path = resolve_group_registry_path();
        let group_registry = load_group_registry(&group_registry_path);
        let planabrain_replies_path = resolve_planabrain_replies_path();
        let planabrain_replies = load_planabrain_replies(&planabrain_replies_path);

        Self {
            bot_username,
            gallery_client,
            booted_at,
            planabrain_replies: Arc::new(RwLock::new(planabrain_replies)),
            planabrain_replies_path,
            group_registry: Arc::new(RwLock::new(group_registry)),
            group_registry_path,
        }
    }

    pub(crate) fn is_after_boot(&self, msg: &Message) -> bool {
        msg.date.timestamp() >= self.booted_at
    }

    pub(crate) fn is_reply_to_planabrain(&self, msg: &Message) -> bool {
        let Some(reply) = msg.reply_to_message() else {
            return false;
        };
        let tracker = self.planabrain_replies.read().ok();
        tracker
            .as_ref()
            .is_some_and(|t| t.contains(reply.chat.id, reply.id))
    }

    pub(crate) async fn record_planabrain_reply(&self, msg: &Message) {
        let snapshot = {
            let mut tracker = match self.planabrain_replies.write() {
                Ok(tracker) => tracker,
                Err(_) => return,
            };
            tracker.insert(msg.chat.id, msg.id);
            tracker.records()
        };

        if let Err(err) =
            persist_planabrain_replies(&self.planabrain_replies_path, &snapshot).await
        {
            warn!("planabrain 응답 기록 저장 실패: {}", err);
        }
    }

    pub(crate) fn group_chat_ids(&self) -> Vec<ChatId> {
        let registry = self.group_registry.read().ok();
        registry
            .as_ref()
            .map(|set| set.iter().copied().collect())
            .unwrap_or_default()
    }

    pub(crate) async fn record_group_chat(&self, msg: &Message) {
        if !is_group_chat(msg) {
            return;
        }

        let chat_id = msg.chat.id;
        let snapshot = {
            let mut registry = match self.group_registry.write() {
                Ok(registry) => registry,
                Err(_) => return,
            };

            if !registry.insert(chat_id) {
                return;
            }

            registry.iter().map(|id| id.0).collect::<Vec<_>>()
        };

        if let Err(err) = persist_group_registry(&self.group_registry_path, &snapshot).await {
            warn!("그룹 목록 저장 실패: {}", err);
        }
    }
}

fn is_group_chat(msg: &Message) -> bool {
    match &msg.chat.kind {
        ChatKind::Public(public) => matches!(
            public.kind,
            PublicChatKind::Group | PublicChatKind::Supergroup(_)
        ),
        _ => false,
    }
}

fn resolve_group_registry_path() -> PathBuf {
    let raw = std::env::var("PLANABOT_GROUPS_PATH")
        .unwrap_or_else(|_| ".planabot/groups.json".to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn resolve_planabrain_replies_path() -> PathBuf {
    let raw = std::env::var("PLANABOT_PLANABRAIN_REPLIES_PATH")
        .unwrap_or_else(|_| ".planabot/planabrain_replies.json".to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn load_group_registry(path: &Path) -> HashSet<ChatId> {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return HashSet::new();
    };
    let Ok(ids) = serde_json::from_str::<Vec<i64>>(&raw) else {
        return HashSet::new();
    };
    ids.into_iter().map(ChatId).collect()
}

fn load_planabrain_replies(path: &Path) -> PlanabrainReplyTracker {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return PlanabrainReplyTracker::new(200);
    };
    let Ok(records) = serde_json::from_str::<Vec<PlanabrainReplyRecord>>(&raw) else {
        return PlanabrainReplyTracker::new(200);
    };
    PlanabrainReplyTracker::from_records(200, records)
}

async fn persist_group_registry(path: &Path, ids: &[i64]) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let mut sorted = ids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    let payload = serde_json::to_string_pretty(&sorted).unwrap_or_else(|_| "[]".to_string());
    fs::write(path, payload).await
}

async fn persist_planabrain_replies(
    path: &Path,
    records: &[PlanabrainReplyRecord],
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).await?;
    }
    let payload =
        serde_json::to_string_pretty(records).unwrap_or_else(|_| "[]".to_string());
    fs::write(path, payload).await
}
