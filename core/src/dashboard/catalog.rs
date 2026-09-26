use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Kind {
    Text,
    Secret,
    Bool,
    Number,
    Select,
    Textarea,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct Group {
    pub id: &'static str,
    pub section: &'static str,
    pub label: &'static str,
    pub description: &'static str,
}

#[derive(Debug, Clone, Copy, Serialize)]
pub(crate) struct Field {
    pub key: &'static str,
    pub group: &'static str,
    pub label: &'static str,
    pub help: &'static str,
    pub kind: Kind,
    pub options: &'static [&'static str],
    pub placeholder: &'static str,
}

const fn field(
    key: &'static str,
    group: &'static str,
    label: &'static str,
    help: &'static str,
    kind: Kind,
) -> Field {
    Field {
        key,
        group,
        label,
        help,
        kind,
        options: &[],
        placeholder: "",
    }
}

const fn hinted(
    key: &'static str,
    group: &'static str,
    label: &'static str,
    help: &'static str,
    kind: Kind,
    placeholder: &'static str,
) -> Field {
    Field {
        key,
        group,
        label,
        help,
        kind,
        options: &[],
        placeholder,
    }
}

const fn select(
    key: &'static str,
    group: &'static str,
    label: &'static str,
    help: &'static str,
    options: &'static [&'static str],
) -> Field {
    Field {
        key,
        group,
        label,
        help,
        kind: Kind::Select,
        options,
        placeholder: "",
    }
}

const THINKING: &[&str] = &["default", "off", "minimal", "low", "medium", "high"];

pub(crate) const GROUPS: &[Group] = &[
    Group {
        id: "telegram",
        section: "봇",
        label: "텔레그램",
        description: "봇 토큰과 공지 채널",
    },
    Group {
        id: "access",
        section: "봇",
        label: "접근 제어",
        description: "planabrain 사용 허용 대상",
    },
    Group {
        id: "media",
        section: "봇",
        label: "링크와 미디어",
        description: "음악 카드와 갤러리 공유",
    },
    Group {
        id: "model",
        section: "planabrain",
        label: "모델",
        description: "codex 모델, 보조 모델, 응답 다듬기",
    },
    Group {
        id: "persona",
        section: "planabrain",
        label: "페르소나",
        description: "시스템 프롬프트와 말투 프로필",
    },
    Group {
        id: "memory",
        section: "planabrain",
        label: "메모리",
        description: "대화 기록과 장기 기억",
    },
    Group {
        id: "webfetch",
        section: "planabrain",
        label: "웹 가져오기",
        description: "링크 본문 수집 한도",
    },
    Group {
        id: "codex",
        section: "제공자",
        label: "Codex 게이트웨이",
        description: "주 모델과 보조 모델 호출",
    },
    Group {
        id: "search",
        section: "제공자",
        label: "웹 검색",
        description: "Ollama 사전 검색",
    },
    Group {
        id: "decision",
        section: "제공자",
        label: "판단 모델",
        description: "OpenRouter Jev 턴 판단과 기억 판단",
    },
    Group {
        id: "system",
        section: "시스템",
        label: "런타임",
        description: "상주 서버, 경로, 헬스체크",
    },
];

pub(crate) const FIELDS: &[Field] = &[
    field(
        "TELEGRAM_API_TOKEN",
        "telegram",
        "봇 토큰",
        "BotFather에서 받은 토큰입니다.",
        Kind::Secret,
    ),
    field(
        "PLANABOT_NOTICE_CHAT_ID",
        "telegram",
        "공지 채팅 ID",
        "공지를 가져올 채널의 숫자 ID입니다.",
        Kind::Number,
    ),
    hinted(
        "PLANABOT_NOTICE_URL",
        "telegram",
        "공지 링크",
        "공지 안내에 붙는 주소입니다.",
        Kind::Text,
        "https://t.me/planabot_noti",
    ),
    field(
        "PLANABRAIN_ENABLED",
        "access",
        "planabrain 사용",
        "끄면 AI 응답을 모두 멈춥니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_ALLOWED_CHAT_IDS",
        "access",
        "허용 채팅",
        "쉼표로 구분한 채팅 ID 목록입니다. 그룹은 여기에 있는 채팅에서만 응답합니다.",
        Kind::Text,
        "-1001234567890,-1009876543210",
    ),
    hinted(
        "PLANABRAIN_ALLOWED_USER_IDS",
        "access",
        "허용 사용자",
        "개인 채팅에서 허용할 사용자 ID 목록입니다. 비우면 모든 개인 채팅을 허용합니다. /chat_id로 ID를 확인합니다.",
        Kind::Text,
        "123456789",
    ),
    field(
        "PLANABOT_MUSIC_CARD_ENABLED",
        "media",
        "음악 카드",
        "음악 링크를 표지 카드 이미지로 보냅니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABOT_MUSIC_CARD_FONT_DIR",
        "media",
        "카드 서체 폴더",
        "카드 렌더링에 쓸 서체 폴더입니다.",
        Kind::Text,
        "/usr/share/fonts",
    ),
    hinted(
        "PLANABOT_MUSIC_CARD_FONT_FAMILY",
        "media",
        "카드 서체 이름",
        "카드에 쓸 서체 패밀리 이름입니다.",
        Kind::Text,
        "Noto Sans CJK KR",
    ),
    hinted(
        "HIROMI_DOWNLOAD_DIR",
        "media",
        "갤러리 임시 폴더",
        "hiromi가 내려받은 파일을 두는 곳입니다.",
        Kind::Text,
        "/tmp/hiromi-downloads",
    ),
    hinted(
        "SENDVIS_HOST",
        "media",
        "공유 호스트",
        "갤러리 공유 링크를 만드는 서버입니다.",
        Kind::Text,
        "https://send.vis.ee",
    ),
    field(
        "CODEX_GATEWAY_API_KEY",
        "codex",
        "API 키",
        "게이트웨이 관리 화면에서 발급한 cg_ 키입니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_CODEX_BASE_URL",
        "codex",
        "게이트웨이 주소",
        "Responses API 기본 주소입니다. 경로가 없으면 /v1을 붙입니다.",
        Kind::Text,
        "http://192.168.0.9:8080/v1",
    ),
    hinted(
        "PLANABRAIN_CODEX_MODEL",
        "codex",
        "주 모델",
        "답변에 쓰는 모델입니다. 비우면 gpt-6-astra를 씁니다.",
        Kind::Text,
        "gpt-6-astra",
    ),
    field(
        "PLANABRAIN_CODEX_FAST",
        "codex",
        "fast 모드",
        "답변 호출에 service_tier priority를 붙입니다. Codex 사용량을 2.5배 쓰며 보조 호출에는 적용하지 않습니다.",
        Kind::Bool,
    ),
    select(
        "PLANABRAIN_CHAT_THINKING_MODE",
        "model",
        "사고 수준",
        "off와 minimal은 low로 보냅니다. default면 모델 기본값을 씁니다.",
        THINKING,
    ),
    hinted(
        "PLANABRAIN_DELIVERY_MAX_OUTPUT_TOKENS",
        "model",
        "전달문 토큰 한도",
        "전달문 재작성에 쓰는 최대 토큰입니다.",
        Kind::Number,
        "1024",
    ),
    field(
        "PLANABRAIN_DELIVERY_REWRITE_ENABLED",
        "model",
        "전달문 재작성",
        "보내기 전에 말투를 한 번 더 다듬습니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_AUX_MODEL",
        "model",
        "보조 모델",
        "검색어 재작성, 전달문 재작성, 기억 작성에 쓸 모델입니다. 비우면 주 모델을 씁니다.",
        Kind::Text,
        "gpt-5.6-sol",
    ),
    field(
        "PLANABRAIN_SEARCH_QUERY_REWRITE",
        "model",
        "검색어 재작성",
        "시의성 질문의 검색어를 모델이 다시 만듭니다.",
        Kind::Bool,
    ),
    field(
        "PLANABRAIN_CONTINUOUS_CHAT",
        "model",
        "연속 대화",
        "지난 대화를 정리된 형태로 매번 다시 보냅니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_HTTP_TIMEOUT_MS",
        "model",
        "HTTP 제한 시간",
        "모델 호출 제한 시간(ms)입니다. codex는 180000을 권합니다.",
        Kind::Number,
        "180000",
    ),
    field(
        "PLANABRAIN_SYSTEM_PROMPT",
        "persona",
        "시스템 프롬프트",
        "비우면 기본 페르소나 프롬프트를 씁니다.",
        Kind::Textarea,
    ),
    select(
        "PLANABRAIN_PERSONA_PROFILE",
        "persona",
        "페르소나 프로필",
        "말투 프로필을 고릅니다.",
        &["live", "original"],
    ),
    field(
        "PLANABRAIN_INTIMACY_ENABLED",
        "persona",
        "친밀 모드",
        "친밀 모드 분기를 켭니다.",
        Kind::Bool,
    ),
    field(
        "PLANABRAIN_INTIMACY_FALLBACK_MODEL",
        "persona",
        "친밀 모드 대체 모델",
        "친밀 모드 재시도에 쓸 모델입니다. 비우면 주 모델을 씁니다.",
        Kind::Text,
    ),
    field(
        "PLANABOT_LOCAL_MEMORY_ENABLED",
        "memory",
        "로컬 메모리",
        "대화 기억을 로컬에 저장합니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_MEMORY_DB_PATH",
        "memory",
        "저장 파일",
        "대화 기록과 장기 기억을 두는 SQLite 파일입니다.",
        Kind::Text,
        ".planabrain/memory.sqlite",
    ),
    hinted(
        "PLANABRAIN_MEMORY_MAX_TURNS",
        "memory",
        "대화 기록 턴 수",
        "대화마다 남길 최근 턴 수입니다.",
        Kind::Number,
        "24",
    ),
    hinted(
        "PLANABRAIN_MEMORY_CONVERSATION_TTL_DAYS",
        "memory",
        "대화 기록 보관 일수",
        "지난 대화 기록을 지우는 기준 일수입니다.",
        Kind::Number,
        "14",
    ),
    hinted(
        "PLANABRAIN_MEMORY_MAX_ITEMS",
        "memory",
        "사용자별 기억 수",
        "사용자 한 명당 남길 장기 기억 수입니다.",
        Kind::Number,
        "200",
    ),
    field(
        "PLANABRAIN_MEMORY_WRITER_ENABLED",
        "memory",
        "장기 기억 정리",
        "답변 뒤 보조 모델로 장기 기억을 추가, 수정, 삭제합니다.",
        Kind::Bool,
    ),
    field(
        "PLANABRAIN_WEB_FETCH_ENABLED",
        "webfetch",
        "웹 가져오기",
        "질문 속 링크의 본문을 읽어 옵니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_WEB_FETCH_TIMEOUT_MS",
        "webfetch",
        "제한 시간(ms)",
        "링크 하나를 기다리는 최대 시간입니다.",
        Kind::Number,
        "10000",
    ),
    hinted(
        "PLANABRAIN_WEB_FETCH_MAX_BYTES",
        "webfetch",
        "최대 바이트",
        "내려받을 응답 본문의 최대 크기입니다.",
        Kind::Number,
        "1000000",
    ),
    hinted(
        "PLANABRAIN_WEB_FETCH_MAX_CHARS",
        "webfetch",
        "링크당 글자 수",
        "링크 하나에서 남길 최대 글자 수입니다.",
        Kind::Number,
        "12000",
    ),
    hinted(
        "PLANABRAIN_WEB_FETCH_MAX_TOTAL_CHARS",
        "webfetch",
        "전체 글자 수",
        "모든 링크를 합친 최대 글자 수입니다.",
        Kind::Number,
        "18000",
    ),
    field(
        "OLLAMA_API_KEY",
        "search",
        "API 키",
        "Ollama 웹 검색 키입니다.",
        Kind::Secret,
    ),
    field(
        "OLLAMA_API_KEYS",
        "search",
        "추가 API 키",
        "쉼표로 구분한 키 목록입니다.",
        Kind::Secret,
    ),
    field(
        "PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH",
        "search",
        "웹 검색",
        "시의성 질문에 Ollama 검색 결과를 답변 전에 미리 넣습니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_OLLAMA_SEARCH_HOST",
        "search",
        "검색 호스트",
        "Ollama 웹 검색 API 주소입니다.",
        Kind::Text,
        "https://ollama.com",
    ),
    hinted(
        "PLANABRAIN_OLLAMA_WEB_SEARCH_MAX_RESULTS",
        "search",
        "검색 결과 수",
        "한 번에 가져올 검색 결과 수입니다.",
        Kind::Number,
        "5",
    ),
    select(
        "PLANABRAIN_DECISION_PROVIDER",
        "decision",
        "판단 모델",
        "비우면 Jev 키가 있을 때 Jev, 없으면 codex 보조 모델이 판단합니다. off는 규칙 판단만 씁니다.",
        &["jev", "codex", "off"],
    ),
    field(
        "OPENROUTER_API_KEY",
        "decision",
        "OpenRouter 키",
        "판단 모델(Jev) 호출에만 씁니다.",
        Kind::Secret,
    ),
    field(
        "PLANABRAIN_DECISION_API_KEY",
        "decision",
        "판단 모델 키",
        "비우면 OpenRouter 키를 씁니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_DECISION_BASE_URL",
        "decision",
        "판단 모델 주소",
        "System One API 기본 주소입니다.",
        Kind::Text,
        "https://openrouter.ai/api",
    ),
    hinted(
        "PLANABRAIN_DECISION_MODEL",
        "decision",
        "판단 모델 이름",
        "System One 모델 이름입니다.",
        Kind::Text,
        "typesafe/jev-1.13",
    ),
    hinted(
        "PLANABRAIN_DECISION_TIMEOUT_MS",
        "decision",
        "판단 제한 시간",
        "Jev 호출이 넘으면 규칙 판단으로 대체합니다(ms).",
        Kind::Number,
        "2500",
    ),
    hinted(
        "PLANABRAIN_DECISION_CODEX_TIMEOUT_MS",
        "decision",
        "codex 판단 제한 시간",
        "codex가 판단할 때 넘으면 규칙 판단으로 대체합니다(ms).",
        Kind::Number,
        "8000",
    ),
    field(
        "PLANABOT_PLANABRAIN_SERVER",
        "system",
        "planabrain 상주 서버",
        "끄면 요청마다 CLI 프로세스를 띄웁니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_SERVER_PORT",
        "system",
        "상주 서버 포트",
        "0이면 빈 포트를 자동으로 고릅니다.",
        Kind::Number,
        "0",
    ),
    hinted(
        "PLANABRAIN_DATA_DIR",
        "system",
        "planabrain 데이터 루트",
        ".planabrain 상대 경로의 기준 폴더입니다.",
        Kind::Text,
        "/app",
    ),
    hinted(
        "PLANABOT_SCHEDULES_PATH",
        "system",
        "일정 파일",
        "예약 작업을 저장하는 파일입니다.",
        Kind::Text,
        ".planabot/schedules.json",
    ),
    field(
        "HEALTH_SECRET_CORE",
        "system",
        "헬스체크 비밀값",
        "설정하면 /health에 secret 쿼리가 필요합니다.",
        Kind::Secret,
    ),
];

pub(crate) fn find(key: &str) -> Option<&'static Field> {
    FIELDS.iter().find(|field| field.key == key)
}

pub(crate) fn looks_secret(key: &str) -> bool {
    ["KEY", "TOKEN", "SECRET", "PASSWORD"]
        .iter()
        .any(|marker| key.contains(marker))
}

#[cfg(test)]
mod tests {
    use super::{FIELDS, GROUPS, Kind, find, looks_secret};
    use std::collections::HashSet;

    #[test]
    fn every_field_points_to_a_known_group() {
        let groups: HashSet<_> = GROUPS.iter().map(|group| group.id).collect();
        for field in FIELDS {
            assert!(groups.contains(field.group), "{}", field.key);
        }
    }

    #[test]
    fn keys_are_unique_and_selects_have_options() {
        let mut seen = HashSet::new();
        for field in FIELDS {
            assert!(seen.insert(field.key), "{}", field.key);
            if field.kind == Kind::Select {
                assert!(!field.options.is_empty(), "{}", field.key);
            }
        }
    }

    #[test]
    fn detects_secret_like_keys() {
        assert!(looks_secret("MY_API_KEY"));
        assert!(looks_secret("PLANABOT_EXTRA_TOKEN"));
        assert!(!looks_secret("PLANABRAIN_CODEX_MODEL"));
        assert_eq!(
            find("CODEX_GATEWAY_API_KEY").map(|f| f.kind),
            Some(Kind::Secret)
        );
        assert!(find("PLANABRAIN_SUB2API_API_KEY").is_none());
    }
}
