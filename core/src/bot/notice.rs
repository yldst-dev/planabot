use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use log::warn;
use serde::{Deserialize, Serialize};
use teloxide::types::{ChatId, MessageId};
use teloxide::{ApiError, RequestError};
use tokio::sync::Mutex as AsyncMutex;

use crate::persist::{read_json_or_default, write_json_atomic};

const MAX_TRACKED_NOTICES: usize = 100;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
struct Progress {
    chat_id: i64,
    message_id: i32,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct NoticeCopies {
    pub button: bool,
    pub copies: Vec<(ChatId, MessageId)>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) enum NoticeFailure {
    Gone,
    Moved(ChatId),
    Other,
}

pub(crate) struct NoticeBoard {
    pub turn: Arc<AsyncMutex<()>>,
    albums: Mutex<HashMap<String, Vec<MessageId>>>,
    copies: Mutex<VecDeque<(MessageId, NoticeCopies)>>,
    progress: AsyncMutex<Option<Progress>>,
    path: PathBuf,
}

impl NoticeBoard {
    pub(crate) fn load() -> Self {
        let raw = std::env::var("PLANABOT_NOTICE_PROGRESS_PATH")
            .unwrap_or_else(|_| ".planabot/notice_progress.json".to_string());
        let path = PathBuf::from(raw);
        let path = if path.is_absolute() {
            path
        } else {
            std::env::current_dir()
                .unwrap_or_else(|_| PathBuf::from("."))
                .join(path)
        };
        Self::at(path)
    }

    fn at(path: PathBuf) -> Self {
        Self {
            turn: Arc::new(AsyncMutex::new(())),
            albums: Mutex::new(HashMap::new()),
            copies: Mutex::new(VecDeque::new()),
            progress: AsyncMutex::new(read_json_or_default(&path)),
            path,
        }
    }

    pub(crate) async fn claim(&self, chat_id: ChatId, message_id: MessageId) -> bool {
        let mut progress = self.progress.lock().await;
        if !is_newer(*progress, chat_id.0, message_id.0) {
            return false;
        }
        let next = Progress {
            chat_id: chat_id.0,
            message_id: message_id.0,
        };
        *progress = Some(next);
        if let Err(err) = write_json_atomic(&self.path, &next).await {
            warn!("공지 전달 위치 저장 실패: {}", err);
        }
        true
    }

    pub(crate) fn add_album_item(&self, group: &str, message_id: MessageId) -> bool {
        let mut albums = self.albums.lock().unwrap_or_else(|e| e.into_inner());
        let items = albums.entry(group.to_string()).or_default();
        items.push(message_id);
        items.len() == 1
    }

    pub(crate) fn take_album(&self, group: &str) -> Vec<MessageId> {
        let mut albums = self.albums.lock().unwrap_or_else(|e| e.into_inner());
        let mut items = albums.remove(group).unwrap_or_default();
        items.sort_by_key(|id| id.0);
        items.dedup();
        items
    }

    pub(crate) fn remember(&self, source: MessageId, copies: NoticeCopies) {
        let mut tracked = self.copies.lock().unwrap_or_else(|e| e.into_inner());
        tracked.retain(|(id, _)| *id != source);
        tracked.push_back((source, copies));
        while tracked.len() > MAX_TRACKED_NOTICES {
            tracked.pop_front();
        }
    }

    pub(crate) fn copies_of(&self, source: MessageId) -> Option<NoticeCopies> {
        let tracked = self.copies.lock().unwrap_or_else(|e| e.into_inner());
        tracked
            .iter()
            .find(|(id, _)| *id == source)
            .map(|(_, copies)| copies.clone())
    }
}

fn is_newer(progress: Option<Progress>, chat_id: i64, message_id: i32) -> bool {
    progress.is_none_or(|last| last.chat_id != chat_id || message_id > last.message_id)
}

pub(crate) fn request_error<E>(err: &E) -> Option<&RequestError>
where
    E: std::error::Error + 'static,
{
    (err as &(dyn std::error::Error + 'static)).downcast_ref::<RequestError>()
}

pub(crate) fn retry_after(err: Option<&RequestError>) -> Option<Duration> {
    match err {
        Some(RequestError::RetryAfter(seconds)) => Some(seconds.duration()),
        _ => None,
    }
}

pub(crate) fn notice_failure(err: Option<&RequestError>) -> NoticeFailure {
    match err {
        Some(RequestError::MigrateToChatId(new_id)) => NoticeFailure::Moved(*new_id),
        Some(RequestError::Api(
            ApiError::BotKicked
            | ApiError::BotKickedFromSupergroup
            | ApiError::BotKickedFromChannel
            | ApiError::ChatNotFound
            | ApiError::GroupDeactivated,
        )) => NoticeFailure::Gone,
        _ => NoticeFailure::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::{NoticeBoard, NoticeCopies, NoticeFailure, notice_failure, retry_after};
    use teloxide::types::{ChatId, MessageId, Seconds};
    use teloxide::{ApiError, RequestError};

    #[tokio::test]
    async fn notices_are_forwarded_once_in_order_and_albums_group() {
        let path = std::env::temp_dir().join(format!(
            "planabot_notice_progress_{}.json",
            std::process::id()
        ));
        let _ = std::fs::remove_file(&path);
        let board = NoticeBoard::at(path.clone());
        let channel = ChatId(-1009);
        assert!(board.claim(channel, MessageId(10)).await);
        assert!(!board.claim(channel, MessageId(10)).await);
        assert!(!board.claim(channel, MessageId(9)).await);
        let reloaded = NoticeBoard::at(path.clone());
        assert!(!reloaded.claim(channel, MessageId(10)).await);
        assert!(reloaded.claim(channel, MessageId(11)).await);
        assert!(reloaded.claim(ChatId(-1010), MessageId(1)).await);
        let _ = std::fs::remove_file(&path);

        assert!(board.add_album_item("a", MessageId(22)));
        assert!(!board.add_album_item("a", MessageId(21)));
        assert_eq!(board.take_album("a"), vec![MessageId(21), MessageId(22)]);
        assert!(board.take_album("a").is_empty());

        let copies = NoticeCopies {
            button: true,
            copies: vec![(ChatId(-1), MessageId(5))],
        };
        board.remember(MessageId(10), copies.clone());
        assert_eq!(board.copies_of(MessageId(10)), Some(copies));
        for id in 0..150 {
            board.remember(
                MessageId(1000 + id),
                NoticeCopies {
                    button: false,
                    copies: Vec::new(),
                },
            );
        }
        assert!(board.copies_of(MessageId(10)).is_none());
    }

    #[test]
    fn send_failures_are_classified() {
        let moved = RequestError::MigrateToChatId(ChatId(-1005));
        let kicked = RequestError::Api(ApiError::BotKickedFromSupergroup);
        let busy = RequestError::RetryAfter(Seconds::from_seconds(3));
        assert_eq!(
            notice_failure(Some(&moved)),
            NoticeFailure::Moved(ChatId(-1005))
        );
        assert_eq!(notice_failure(Some(&kicked)), NoticeFailure::Gone);
        assert_eq!(notice_failure(Some(&busy)), NoticeFailure::Other);
        assert_eq!(notice_failure(None), NoticeFailure::Other);
        assert_eq!(
            retry_after(Some(&busy)),
            Some(std::time::Duration::from_secs(3))
        );
        assert_eq!(retry_after(Some(&kicked)), None);
    }
}
