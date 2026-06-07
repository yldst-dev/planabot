use teloxide::utils::command::BotCommands;

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
    #[command(description = "오늘 할 일 확인")]
    Todo,
    #[command(description = "일정 확인 또는 등록")]
    Schedule,
    #[command(description = "타이머 등록")]
    Timer,
    #[command(description = "현재 그룹 ID 확인")]
    GroupInfo,
}
