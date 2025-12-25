use std::collections::VecDeque;
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use teloxide::types::{ChatId, Message, MessageId};

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
}

#[derive(Clone)]
pub struct AppState {
    pub bot_username: String,
    pub gallery_client: GalleryClient,
    booted_at: i64,
    planabrain_replies: Arc<RwLock<PlanabrainReplyTracker>>,
}

impl AppState {
    pub fn new(bot_username: String, gallery_client: GalleryClient) -> Self {
        let booted_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs() as i64;

        Self {
            bot_username,
            gallery_client,
            booted_at,
            planabrain_replies: Arc::new(RwLock::new(PlanabrainReplyTracker::new(200))),
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

    pub(crate) fn record_planabrain_reply(&self, msg: &Message) {
        if let Ok(mut tracker) = self.planabrain_replies.write() {
            tracker.insert(msg.chat.id, msg.id);
        }
    }
}
