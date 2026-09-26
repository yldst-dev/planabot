use teloxide::utils::command::BotCommands;

pub(crate) const PRIVATE_ONLY_COMMAND: &str = "chat_id";

#[derive(BotCommands, Clone, PartialEq, Eq)]
#[command(rename_rule = "lowercase", description = "사용 가능한 명령어")]
pub(crate) enum Command {
    #[command(description = "봇 사용법 안내")]
    Start,
    #[command(description = "봇 상태 확인")]
    Ping,
    #[command(description = "현재 실행 버전 확인")]
    Version,
    #[command(description = "답장 메시지 토큰 측정")]
    Token,
    #[command(description = "내 대화 메모리 초기화")]
    MemoryReset,
    #[command(description = "저장된 기억 확인")]
    Memory,
    #[command(description = "기억 하나 삭제 (/forget 번호)")]
    Forget,
    #[command(description = "오늘 할 일 확인")]
    Todo,
    #[command(description = "일정 확인 또는 등록")]
    Schedule,
    #[command(description = "타이머 등록")]
    Timer,
    #[command(description = "현재 그룹 ID 확인")]
    GroupInfo,
    #[command(rename = "chat_id", description = "내 채팅 ID 확인")]
    ChatId,
    #[command(description = "USDT 후원 안내")]
    Donation,
}

#[cfg(test)]
mod tests {
    use super::{Command, PRIVATE_ONLY_COMMAND};
    use teloxide::utils::command::BotCommands;

    #[test]
    fn chat_id_command_is_registered_and_parsed() {
        assert!(
            Command::bot_commands()
                .iter()
                .any(|command| command.command.trim_start_matches('/') == PRIVATE_ONLY_COMMAND)
        );
        assert!(matches!(
            Command::parse("/chat_id", "planabot"),
            Ok(Command::ChatId)
        ));
        assert!(matches!(
            Command::parse("/chat_id@planabot", "planabot"),
            Ok(Command::ChatId)
        ));
    }
}
