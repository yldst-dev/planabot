use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, RwLock, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use log::warn;
use serde::{Deserialize, Serialize};
use teloxide::types::{ChatId, ChatKind, Message, MessageId, PublicChatKind, UserId};
use tokio::sync::{Mutex as AsyncMutex, OwnedSemaphorePermit, Semaphore};

use super::media::{ImageSource, MediaGroupCache, extract_image_source};
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
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    images: Vec<ImageSource>,
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
    media_groups: Arc<Mutex<MediaGroupCache>>,
    planabrain_semaphore: Arc<Semaphore>,
    planabrain_conversations: Arc<Mutex<HashMap<String, Weak<AsyncMutex<()>>>>>,
    pub(crate) schedule_store: ScheduleStore,
    share_claims: Arc<RwLock<HashMap<String, StoredShareClaim>>>,
    share_claims_path: PathBuf,
    write_lock: Arc<AsyncMutex<()>>,
    pub hiromi_bin: PathBuf,
    gallery_jobs: Arc<Mutex<HashSet<String>>>,
    gallery_job_slots: Arc<Semaphore>,
}

pub(crate) struct GalleryJob {
    jobs: Arc<Mutex<HashSet<String>>>,
    gallery_id: String,
}

fn start_job(jobs: &Arc<Mutex<HashSet<String>>>, gallery_id: &str) -> Option<GalleryJob> {
    let mut running = jobs.lock().unwrap_or_else(|e| e.into_inner());
    running.insert(gallery_id.to_string()).then(|| GalleryJob {
        jobs: jobs.clone(),
        gallery_id: gallery_id.to_string(),
    })
}

impl Drop for GalleryJob {
    fn drop(&mut self) {
        let mut jobs = self.jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.remove(&self.gallery_id);
    }
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
            media_groups: Arc::new(Mutex::new(MediaGroupCache::default())),
            planabrain_semaphore: Arc::new(Semaphore::new(4)),
            planabrain_conversations: Arc::new(Mutex::new(HashMap::new())),
            schedule_store,
            share_claims: Arc::new(RwLock::new(share_claims)),
            share_claims_path,
            write_lock: Arc::new(AsyncMutex::new(())),
            hiromi_bin,
            gallery_jobs: Arc::new(Mutex::new(HashSet::new())),
            gallery_job_slots: Arc::new(Semaphore::new(2)),
        }
    }

    pub(crate) fn start_gallery_job(&self, gallery_id: &str) -> Option<GalleryJob> {
        start_job(&self.gallery_jobs, gallery_id)
    }

    pub(crate) fn is_gallery_job_running(&self, gallery_id: &str) -> bool {
        let jobs = self.gallery_jobs.lock().unwrap_or_else(|e| e.into_inner());
        jobs.contains(gallery_id)
    }

    pub(crate) async fn gallery_job_slot(&self) -> Option<OwnedSemaphorePermit> {
        self.gallery_job_slots.clone().acquire_owned().await.ok()
    }

    pub(crate) async fn put_share_claim(&self, claim: ShareClaim) {
        let _guard = self.write_lock.lock().await;
        let now = unix_now_ms();
        let snapshot = {
            let mut claims = match self.share_claims.write() {
                Ok(claims) => claims,
                Err(_) => return,
            };
            claims.retain(|_, stored| keep_live_claim(stored, now));
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
        let Some(reply) = conversation_reply(msg) else {
            return planabrain_default_scope_id(msg);
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

    pub(crate) fn planabrain_reply_owner_user_id(&self, msg: &Message) -> Option<u64> {
        let reply = msg.reply_to_message()?;
        let tracker = self.planabrain_replies.read().ok()?;
        let record = tracker.get(reply.chat.id, reply.id)?;
        let scope = &record.conversation_scope_id;
        let raw_owner = scope
            .strip_prefix("todo_")
            .or_else(|| scope.strip_prefix("schedule_"))
            .and_then(|value| value.parse::<u64>().ok())?;
        Some(record.owner_user_id.unwrap_or(raw_owner))
    }

    pub(crate) async fn record_planabrain_reply(&self, msg: &Message, conversation_scope_id: &str) {
        self.record_planabrain_reply_with_owner(msg, conversation_scope_id, None, Vec::new())
            .await;
    }

    pub(crate) async fn record_planabrain_reply_with_images(
        &self,
        msg: &Message,
        conversation_scope_id: &str,
        images: Vec<ImageSource>,
    ) {
        self.record_planabrain_reply_with_owner(msg, conversation_scope_id, None, images)
            .await;
    }

    pub(crate) fn planabrain_reply_images(&self, msg: &Message) -> Vec<ImageSource> {
        let Some(reply) = msg.reply_to_message() else {
            return Vec::new();
        };
        self.planabrain_replies
            .read()
            .ok()
            .and_then(|tracker| tracker.get(reply.chat.id, reply.id))
            .map(|record| record.images)
            .unwrap_or_default()
    }

    pub(crate) fn record_media_group(&self, msg: &Message) {
        let Some(group) = msg.media_group_id() else {
            return;
        };
        let Some(source) = extract_image_source(msg) else {
            return;
        };
        let mut cache = self.media_groups.lock().unwrap_or_else(|e| e.into_inner());
        cache.record(msg.chat.id.0, &group.0, msg.id.0, source);
    }

    pub(crate) fn media_group_images(&self, msg: &Message) -> Vec<ImageSource> {
        let Some(group) = msg.media_group_id() else {
            return Vec::new();
        };
        let cache = self.media_groups.lock().unwrap_or_else(|e| e.into_inner());
        cache.images(msg.chat.id.0, &group.0)
    }

    pub(crate) fn claim_media_group_turn(&self, msg: &Message) -> bool {
        let Some(group) = msg.media_group_id() else {
            return true;
        };
        let mut cache = self.media_groups.lock().unwrap_or_else(|e| e.into_inner());
        cache.claim(msg.chat.id.0, &group.0)
    }

    pub(crate) async fn record_planabrain_reply_for_user(
        &self,
        msg: &Message,
        conversation_scope_id: &str,
        owner_user_id: u64,
    ) {
        self.record_planabrain_reply_with_owner(
            msg,
            conversation_scope_id,
            Some(owner_user_id),
            Vec::new(),
        )
        .await;
    }

    async fn record_planabrain_reply_with_owner(
        &self,
        msg: &Message,
        conversation_scope_id: &str,
        owner_user_id: Option<u64>,
        images: Vec<ImageSource>,
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
                images,
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

const SENDER_CHAT_USER_BASE: u64 = 1 << 60;

pub(crate) fn requester_user_id(msg: &Message) -> Option<u64> {
    match msg.sender_chat.as_ref() {
        Some(chat) => Some(SENDER_CHAT_USER_BASE | chat.id.0.unsigned_abs()),
        None => msg.from.as_ref().map(|user| user.id.0),
    }
}

pub(crate) fn conversation_reply(msg: &Message) -> Option<&Message> {
    msg.reply_to_message()
        .filter(|reply| reply.forum_topic_created().is_none())
}

pub(crate) fn planabrain_default_scope_id(msg: &Message) -> String {
    default_conversation_scope_id(
        msg.chat.id.0,
        msg.chat.is_private(),
        msg.from.as_ref().map(|user| user.id.0),
    )
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

fn keep_live_claim(stored: &StoredShareClaim, now_ms: i64) -> bool {
    if is_share_claim_live(stored.created_at_ms, now_ms) {
        return true;
    }
    if stored.claim.path.is_empty() {
        return false;
    }
    match std::fs::remove_file(&stored.claim.path) {
        Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
            warn!("만료된 뷰어 파일 삭제 실패: {}", err);
        }
        _ => {}
    }
    false
}

fn load_share_claims(path: &Path, now_ms: i64) -> HashMap<String, StoredShareClaim> {
    read_json_or_default::<Vec<StoredShareClaim>>(path)
        .into_iter()
        .filter(|stored| keep_live_claim(stored, now_ms))
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
        ImageSource, PlanabrainReplyRecord, PlanabrainReplyTracker, SHARE_CLAIM_TTL_MS,
        StoredShareClaim, is_share_claim_live, load_share_claims,
    };
    use crate::hiromi_share::ShareClaim;

    fn message(json: serde_json::Value) -> teloxide::types::Message {
        serde_json::from_value(json).expect("message json")
    }

    #[test]
    fn anonymous_admins_get_one_identity_per_group() {
        let anonymous = |chat_id: i64| {
            message(serde_json::json!({
                "message_id": 1, "date": 0, "text": "프라나야 일정 보여줘",
                "chat": {"id": chat_id, "title": "g", "type": "supergroup"},
                "sender_chat": {"id": chat_id, "title": "g", "type": "supergroup"},
                "from": {"id": 1087968824, "is_bot": true, "first_name": "Group", "username": "GroupAnonymousBot"}
            }))
        };
        let first = super::requester_user_id(&anonymous(-1001)).expect("first group");
        let second = super::requester_user_id(&anonymous(-1002)).expect("second group");
        assert_ne!(first, second);
        assert_ne!(first, 1087968824);
        assert!(first >= 1 << 52);
        let person = message(serde_json::json!({
            "message_id": 2, "date": 0, "text": "안녕",
            "chat": {"id": -1001, "title": "g", "type": "supergroup"},
            "from": {"id": 42, "is_bot": false, "first_name": "A"}
        }));
        assert_eq!(super::requester_user_id(&person), Some(42));
    }

    #[test]
    fn forum_topic_messages_are_not_treated_as_replies() {
        let topic = message(serde_json::json!({
            "chat": {"id": -1001847508954_i64, "is_forum": true, "title": "t", "type": "supergroup"},
            "date": 1675229140, "from": {"first_name": "A", "id": 1253681278, "is_bot": false},
            "is_topic_message": true, "message_id": 5, "message_thread_id": 4, "text": "프라나야 안녕",
            "reply_to_message": {
                "chat": {"id": -1001847508954_i64, "is_forum": true, "title": "t", "type": "supergroup"},
                "date": 1675229139, "forum_topic_created": {"icon_color": 9367192, "name": "주제"},
                "from": {"first_name": "A", "id": 1253681278, "is_bot": false},
                "is_topic_message": true, "message_id": 4, "message_thread_id": 4
            }
        }));
        assert!(topic.reply_to_message().is_some());
        assert!(super::conversation_reply(&topic).is_none());
        assert_eq!(
            super::planabrain_default_scope_id(&topic),
            "chat_-1001847508954_user_1253681278"
        );
    }

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
    fn a_gallery_job_runs_once_until_it_finishes() {
        let jobs = std::sync::Arc::new(std::sync::Mutex::new(std::collections::HashSet::new()));
        let first = super::start_job(&jobs, "3723891").expect("first job");
        assert!(super::start_job(&jobs, "3723891").is_none());
        assert!(super::start_job(&jobs, "1234567").is_some());
        drop(first);
        assert!(super::start_job(&jobs, "3723891").is_some());
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
        let stale_file = dir.join(format!("planabot_stale_viewer_{}.html", std::process::id()));
        std::fs::write(&stale_file, "viewer").unwrap();
        let stored = vec![
            StoredShareClaim {
                claim: claim("fresh"),
                created_at_ms: 10_000,
            },
            StoredShareClaim {
                claim: ShareClaim {
                    path: stale_file.to_string_lossy().into_owned(),
                    ..claim("stale")
                },
                created_at_ms: 0,
            },
        ];
        std::fs::write(&path, serde_json::to_string(&stored).unwrap()).unwrap();
        let loaded = load_share_claims(&path, SHARE_CLAIM_TTL_MS + 5_000);
        assert!(loaded.contains_key("fresh"));
        assert!(!loaded.contains_key("stale"));
        assert!(!stale_file.exists());
        let _ = std::fs::remove_file(path);
    }
    use teloxide::types::{ChatId, MessageId};

    #[test]
    fn reply_records_keep_images_and_read_old_files_without_them() {
        let record = PlanabrainReplyRecord {
            chat_id: 1,
            message_id: 2,
            conversation_scope_id: "chat_1".to_string(),
            owner_user_id: None,
            images: vec![ImageSource {
                file_id: "photo".to_string(),
                mime_type: "image/jpeg".to_string(),
            }],
        };
        let json = serde_json::to_string(&record).expect("serialize");
        let restored: PlanabrainReplyRecord = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(restored.images, record.images);
        let old: PlanabrainReplyRecord =
            serde_json::from_str(r#"{"chat_id":1,"message_id":2}"#).expect("old record");
        assert!(old.images.is_empty());
        let plain = serde_json::to_string(&old).expect("serialize");
        assert!(!plain.contains("images"));
    }

    #[test]
    fn tracker_returns_saved_conversation_scope() {
        let mut tracker = PlanabrainReplyTracker::new(10);
        tracker.insert(PlanabrainReplyRecord {
            chat_id: 100,
            message_id: 42,
            conversation_scope_id: "msg_40".to_string(),
            owner_user_id: None,
            images: Vec::new(),
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
