use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::warn;
use serde::{Deserialize, Serialize};
use teloxide::types::{ChatId, ChatKind, Message, MessageId, PublicChatKind, UserId};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};

use crate::hiromi_share::ShareClaim;
use crate::hitomi::GalleryClient;
use crate::persist::{read_json_or_default, write_json_atomic};
use crate::schedule::ScheduleStore;

#[derive(Debug)]
struct PlanabrainReplyTracker {
    max: usize,
    items: VecDeque<PlanabrainReplyRecord>,
}

impl PlanabrainReplyTracker {
    fn new(max: usize) -> Self {
        Self {
            max,
            items: VecDeque::new(),
        }
    }

    fn contains(&self, chat_id: ChatId, message_id: MessageId) -> bool {
        self.get(chat_id, message_id).is_some()
    }

    fn get(&self, chat_id: ChatId, message_id: MessageId) -> Option<PlanabrainReplyRecord> {
        self.items
            .iter()
            .find(|record| record.chat_id == chat_id.0 && record.message_id == message_id.0)
            .cloned()
    }

    fn insert(&mut self, record: PlanabrainReplyRecord) {
        if let Some(pos) = self
            .items
            .iter()
            .position(|item| item.chat_id == record.chat_id && item.message_id == record.message_id)
        {
            self.items.remove(pos);
        }

        self.items.push_back(record);
        while self.items.len() > self.max {
            self.items.pop_front();
        }
    }

    fn from_records(max: usize, records: Vec<PlanabrainReplyRecord>) -> Self {
        let mut items = VecDeque::from(records);
        while items.len() > max {
            items.pop_front();
        }
        Self { max, items }
    }

    fn records(&self) -> Vec<PlanabrainReplyRecord> {
        self.items.iter().cloned().collect()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PlanabrainReplyRecord {
    chat_id: i64,
    message_id: i32,
    #[serde(default)]
    conversation_scope_id: String,
    #[serde(default)]
    owner_user_id: Option<u64>,
}

#[derive(Clone)]
pub struct AppState {
    pub bot_username: String,
    pub bot_user_id: UserId,
    pub gallery_client: GalleryClient,
    pub notice_chat_id: Option<ChatId>,
    pub notice_url: Option<String>,
    booted_at: i64,
    planabrain_replies: Arc<RwLock<PlanabrainReplyTracker>>,
    planabrain_replies_path: PathBuf,
    group_registry: Arc<RwLock<HashSet<ChatId>>>,
    group_registry_path: PathBuf,
    image_rate_limiter: Arc<Mutex<ImageRateLimiter>>,
    planabrain_semaphore: Arc<Semaphore>,
    planabrain_conversations: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    pub(crate) schedule_store: ScheduleStore,
    share_claims: Arc<RwLock<HashMap<String, StoredShareClaim>>>,
    share_claims_path: PathBuf,
    write_lock: Arc<AsyncMutex<()>>,
    pub hiromi_bin: PathBuf,
}

const SHARE_CLAIM_TTL_MS: i64 = 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredShareClaim {
    claim: ShareClaim,
    created_at_ms: i64,
}

fn is_share_claim_live(created_at_ms: i64, now_ms: i64) -> bool {
    now_ms.saturating_sub(created_at_ms) < SHARE_CLAIM_TTL_MS
}

fn unix_now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_millis() as i64)
        .unwrap_or(0)
}

impl AppState {
    pub fn new(
        bot_username: String,
        bot_user_id: UserId,
        gallery_client: GalleryClient,
        notice_chat_id: Option<ChatId>,
        notice_url: Option<String>,
    ) -> Self {
        let booted_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        let group_registry_path = resolve_group_registry_path();
        let group_registry = load_group_registry(&group_registry_path);
        let planabrain_replies_path = resolve_planabrain_replies_path();
        let planabrain_replies = load_planabrain_replies(&planabrain_replies_path);
        let image_rate_limiter = ImageRateLimiter::new(2, Duration::from_secs(60));
        let schedule_store = ScheduleStore::new();
        let hiromi_bin = crate::hiromi_share::hiromi_bin();
        let share_claims_path = resolve_share_claims_path();
        let share_claims = load_share_claims(&share_claims_path, unix_now_ms());

        Self {
            bot_username,
            bot_user_id,
            gallery_client,
            notice_chat_id,
            notice_url,
            booted_at,
            planabrain_replies: Arc::new(RwLock::new(planabrain_replies)),
            planabrain_replies_path,
            group_registry: Arc::new(RwLock::new(group_registry)),
            group_registry_path,
            image_rate_limiter: Arc::new(Mutex::new(image_rate_limiter)),
            planabrain_semaphore: Arc::new(Semaphore::new(4)),
            planabrain_conversations: Arc::new(Mutex::new(HashMap::new())),
            schedule_store,
            share_claims: Arc::new(RwLock::new(share_claims)),
            share_claims_path,
            write_lock: Arc::new(AsyncMutex::new(())),
            hiromi_bin,
        }
    }

    pub(crate) async fn put_share_claim(&self, claim: ShareClaim) {
        let _guard = self.write_lock.lock().await;
        let now = unix_now_ms();
        let snapshot = {
            let mut claims = match self.share_claims.write() {
                Ok(claims) => claims,
                Err(_) => return,
            };
            claims.retain(|_, stored| is_share_claim_live(stored.created_at_ms, now));
            claims.insert(
                claim.token.clone(),
                StoredShareClaim {
                    claim,
                    created_at_ms: now,
                },
            );
            claims.values().cloned().collect::<Vec<_>>()
        };
        if let Err(err) = write_json_atomic(&self.share_claims_path, &snapshot).await {
            warn!("갤러리 다운로드 청구 저장 실패: {}", err);
        }
    }

    pub(crate) fn get_share_claim(&self, token: &str) -> Option<ShareClaim> {
        let now = unix_now_ms();
        self.share_claims.read().ok().and_then(|claims| {
            claims
                .get(token)
                .filter(|stored| is_share_claim_live(stored.created_at_ms, now))
                .map(|stored| stored.claim.clone())
        })
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

    pub(crate) fn planabrain_conversation_scope_id(&self, msg: &Message) -> String {
        let Some(reply) = msg.reply_to_message() else {
            return default_conversation_scope_id(
                msg.chat.id.0,
                msg.chat.is_private(),
                msg.from.as_ref().map(|user| user.id.0),
            );
        };
        let tracker = self.planabrain_replies.read().ok();
        if let Some(record) = tracker
            .as_ref()
            .and_then(|tracker| tracker.get(reply.chat.id, reply.id))
            .filter(|record| !record.conversation_scope_id.trim().is_empty())
        {
            return record.conversation_scope_id;
        }
        format!("reply_{}", reply.id.0)
    }

    pub(crate) fn planabrain_todo_reply_owner_user_id(&self, msg: &Message) -> Option<u64> {
        let reply = msg.reply_to_message()?;
        let tracker = self.planabrain_replies.read().ok()?;
        let record = tracker.get(reply.chat.id, reply.id)?;
        let raw_owner = record
            .conversation_scope_id
            .strip_prefix("todo_")
            .and_then(|value| value.parse::<u64>().ok())?;
        Some(record.owner_user_id.unwrap_or(raw_owner))
    }

    pub(crate) async fn record_planabrain_reply(&self, msg: &Message, conversation_scope_id: &str) {
        self.record_planabrain_reply_with_owner(msg, conversation_scope_id, None)
            .await;
    }

    pub(crate) async fn record_planabrain_reply_for_user(
        &self,
        msg: &Message,
        conversation_scope_id: &str,
        owner_user_id: u64,
    ) {
        self.record_planabrain_reply_with_owner(msg, conversation_scope_id, Some(owner_user_id))
            .await;
    }

    async fn record_planabrain_reply_with_owner(
        &self,
        msg: &Message,
        conversation_scope_id: &str,
        owner_user_id: Option<u64>,
    ) {
        let _guard = self.write_lock.lock().await;
        let snapshot = {
            let mut tracker = match self.planabrain_replies.write() {
                Ok(tracker) => tracker,
                Err(_) => return,
            };
            tracker.insert(PlanabrainReplyRecord {
                chat_id: msg.chat.id.0,
                message_id: msg.id.0,
                conversation_scope_id: conversation_scope_id.to_string(),
                owner_user_id,
            });
            tracker.records()
        };

        if let Err(err) = persist_planabrain_replies(&self.planabrain_replies_path, &snapshot).await
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
        let _guard = self.write_lock.lock().await;
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

    pub(crate) async fn allow_image_request(&self, user_id: i64) -> bool {
        let mut limiter = match self.image_rate_limiter.lock() {
            Ok(limiter) => limiter,
            Err(poisoned) => poisoned.into_inner(),
        };
        limiter.allow(user_id)
    }

    pub(crate) fn planabrain_conversation_lock(&self, key: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self
            .planabrain_conversations
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        locks.retain(|_, value| value.strong_count() > 0);
        if let Some(lock) = locks.get(key).and_then(Weak::upgrade) {
            return lock;
        }
        let lock = Arc::new(AsyncMutex::new(()));
        locks.insert(key.to_string(), Arc::downgrade(&lock));
        lock
    }

    pub(crate) fn try_acquire_planabrain_permit(&self) -> Option<OwnedSemaphorePermit> {
        self.planabrain_semaphore.clone().try_acquire_owned().ok()
    }
}

struct ImageRateLimiter {
    limit: usize,
    window: Duration,
    entries: HashMap<i64, VecDeque<Instant>>,
}

impl ImageRateLimiter {
    fn new(limit: usize, window: Duration) -> Self {
        Self {
            limit,
            window,
            entries: std::collections::HashMap::new(),
        }
    }

    fn allow(&mut self, user_id: i64) -> bool {
        let now = Instant::now();
        let queue = self.entries.entry(user_id).or_default();
        while let Some(front) = queue.front().copied() {
            if now.duration_since(front) > self.window {
                queue.pop_front();
            } else {
                break;
            }
        }
        if queue.len() >= self.limit {
            return false;
        }
        queue.push_back(now);
        true
    }
}

fn default_conversation_scope_id(chat_id: i64, is_private: bool, user_id: Option<u64>) -> String {
    if is_private {
        return format!("chat_{chat_id}");
    }
    match user_id {
        Some(user_id) => format!("chat_{chat_id}_user_{user_id}"),
        None => format!("chat_{chat_id}"),
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

fn resolve_share_claims_path() -> PathBuf {
    let raw = std::env::var("PLANABOT_SHARE_CLAIMS_PATH")
        .unwrap_or_else(|_| ".planabot/share_claims.json".to_string());
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        path
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    }
}

fn load_share_claims(path: &Path, now_ms: i64) -> HashMap<String, StoredShareClaim> {
    read_json_or_default::<Vec<StoredShareClaim>>(path)
        .into_iter()
        .filter(|stored| is_share_claim_live(stored.created_at_ms, now_ms))
        .map(|stored| (stored.claim.token.clone(), stored))
        .collect()
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
    let mut sorted = ids.to_vec();
    sorted.sort_unstable();
    sorted.dedup();
    write_json_atomic(path, &sorted).await
}

async fn persist_planabrain_replies(
    path: &Path,
    records: &[PlanabrainReplyRecord],
) -> std::io::Result<()> {
    write_json_atomic(path, records).await
}

#[cfg(test)]
mod tests {
    use super::{
        PlanabrainReplyRecord, PlanabrainReplyTracker, SHARE_CLAIM_TTL_MS, StoredShareClaim,
        is_share_claim_live, load_share_claims,
    };
    use crate::hiromi_share::ShareClaim;

    #[test]
    fn default_conversation_scope_is_per_chat_privately_and_per_user_in_groups() {
        assert_eq!(
            super::default_conversation_scope_id(7, true, Some(1)),
            "chat_7"
        );
        assert_eq!(
            super::default_conversation_scope_id(-100, false, Some(42)),
            "chat_-100_user_42"
        );
        assert_eq!(
            super::default_conversation_scope_id(-100, false, None),
            "chat_-100"
        );
    }

    #[test]
    fn share_claims_expire_after_ttl() {
        assert!(is_share_claim_live(1_000, 1_000 + SHARE_CLAIM_TTL_MS - 1));
        assert!(!is_share_claim_live(1_000, 1_000 + SHARE_CLAIM_TTL_MS));
    }

    #[test]
    fn expired_share_claims_are_dropped_on_load() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("planabot_share_claims_{}.json", std::process::id()));
        let claim = |token: &str| ShareClaim {
            token: token.to_string(),
            gallery_id: "1".into(),
            title: "t".into(),
            pages: 1,
            url: String::new(),
            path: String::new(),
            size: 0,
        };
        let stored = vec![
            StoredShareClaim {
                claim: claim("fresh"),
                created_at_ms: 10_000,
            },
            StoredShareClaim {
                claim: claim("stale"),
                created_at_ms: 0,
            },
        ];
        std::fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();
        let loaded = load_share_claims(&path, SHARE_CLAIM_TTL_MS + 5_000);
        assert!(loaded.contains_key("fresh"));
        assert!(!loaded.contains_key("stale"));
        let _ = std::fs::remove_file(path);
    }
    use teloxide::types::{ChatId, MessageId};

    #[test]
    fn tracker_returns_saved_conversation_scope() {
        let mut tracker = PlanabrainReplyTracker::new(10);
        tracker.insert(PlanabrainReplyRecord {
            chat_id: 100,
            message_id: 42,
            conversation_scope_id: "msg_40".to_string(),
            owner_user_id: None,
        });

        let record = tracker.get(ChatId(100), MessageId(42)).unwrap();
        assert_eq!(record.conversation_scope_id, "msg_40");
    }

    #[test]
    fn legacy_reply_records_deserialize_without_conversation_scope() {
        let raw = r#"[{"chat_id":1,"message_id":2}]"#;
        let parsed: Vec<PlanabrainReplyRecord> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].conversation_scope_id, "");
        assert_eq!(parsed[0].owner_user_id, None);
    }

    #[test]
    fn reply_records_deserialize_with_owner_user_id() {
        let raw = r#"[{"chat_id":1,"message_id":2,"conversation_scope_id":"todo_10","owner_user_id":10}]"#;
        let parsed: Vec<PlanabrainReplyRecord> = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].conversation_scope_id, "todo_10");
        assert_eq!(parsed[0].owner_user_id, Some(10));
    }
}
