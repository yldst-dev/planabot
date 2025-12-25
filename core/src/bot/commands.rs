use teloxide::utils::command::BotCommands;

#[derive(BotCommands, Clone, PartialEq, Eq)]
#[command(rename_rule = "lowercase", description = "사용 가능한 명령어")]
pub(crate) enum Command {
    #[command(description = "봇 사용법 안내")]
    Start,
    #[command(description = "봇 상태 확인")]
    Ping,
    #[command(description = "내 대화 메모리 초기화")]
    MemoryReset,
}
