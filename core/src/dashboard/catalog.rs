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

const PROVIDERS: &[&str] = &[
    "google",
    "vertexexpress",
    "geminimock",
    "openrouter",
    "ollama",
    "cerebras",
    "modelstudio",
    "geminiweb",
];

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
        description: "주 제공자, 모델, 출력 한도",
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
        description: "로컬 대화 기억과 압축",
    },
    Group {
        id: "webfetch",
        section: "planabrain",
        label: "웹 가져오기",
        description: "링크 본문 수집 한도",
    },
    Group {
        id: "google",
        section: "제공자",
        label: "Google",
        description: "Gemini API",
    },
    Group {
        id: "vertexexpress",
        section: "제공자",
        label: "Vertex Express",
        description: "Vertex AI 익스프레스 모드",
    },
    Group {
        id: "openrouter",
        section: "제공자",
        label: "OpenRouter",
        description: "OpenRouter 라우팅과 웹 검색",
    },
    Group {
        id: "ollama",
        section: "제공자",
        label: "Ollama",
        description: "Ollama 호스트와 도구 호출",
    },
    Group {
        id: "cerebras",
        section: "제공자",
        label: "Cerebras",
        description: "Cerebras 추론 API",
    },
    Group {
        id: "modelstudio",
        section: "제공자",
        label: "Model Studio",
        description: "Alibaba Cloud Model Studio",
    },
    Group {
        id: "geminiweb",
        section: "제공자",
        label: "Geminiweb",
        description: "자체 호스팅 게이트웨이",
    },
    Group {
        id: "geminimock",
        section: "제공자",
        label: "GeminiMock",
        description: "로컬 Gemini CLI 브리지",
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
        "PLANABOT_TELEGRAM_DRAFT_ENABLED",
        "telegram",
        "초안 스트리밍",
        "답장을 초안 메시지로 이어서 보여 줍니다.",
        Kind::Bool,
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
        "쉼표로 구분한 채팅 ID 목록입니다.",
        Kind::Text,
        "-1001234567890,-1009876543210",
    ),
    hinted(
        "PLANABRAIN_ALLOWED_USER_IDS",
        "access",
        "허용 사용자",
        "쉼표로 구분한 사용자 ID 목록입니다.",
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
    select(
        "PLANABRAIN_AI_PROVIDER",
        "model",
        "주 제공자",
        "대화 응답에 쓰는 제공자입니다.",
        PROVIDERS,
    ),
    hinted(
        "PLANABRAIN_CHAT_MODEL",
        "model",
        "대화 모델",
        "제공자별 모델 값이 없을 때 쓰입니다.",
        Kind::Text,
        "gemini-3-flash-preview",
    ),
    select(
        "PLANABRAIN_CHAT_THINKING_MODE",
        "model",
        "사고 수준",
        "지원하는 모델에서만 적용됩니다.",
        THINKING,
    ),
    hinted(
        "PLANABRAIN_CHAT_MAX_OUTPUT_TOKENS",
        "model",
        "응답 토큰 한도",
        "한 번의 답변에 쓰는 최대 토큰입니다.",
        Kind::Number,
        "2048",
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
    select(
        "PLANABRAIN_AUX_PROVIDER",
        "model",
        "보조 제공자",
        "검색어와 전달문 재작성용입니다. 비우면 주 제공자를 씁니다.",
        PROVIDERS,
    ),
    hinted(
        "PLANABRAIN_AUX_MODEL",
        "model",
        "보조 모델",
        "보조 제공자에서 쓸 모델입니다.",
        Kind::Text,
        "gemma4:31b",
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
        "이전 턴 원문을 그대로 다시 보냅니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_HTTP_TIMEOUT_MS",
        "model",
        "HTTP 제한 시간",
        "제공자 호출 제한 시간(ms)입니다.",
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
    select(
        "PLANABRAIN_INTIMACY_FALLBACK_PROVIDER",
        "persona",
        "친밀 모드 대체 제공자",
        "친밀 모드에서 쓸 제공자입니다.",
        PROVIDERS,
    ),
    field(
        "PLANABRAIN_INTIMACY_FALLBACK_MODEL",
        "persona",
        "친밀 모드 대체 모델",
        "대체 제공자에서 쓸 모델입니다.",
        Kind::Text,
    ),
    field(
        "PLANABOT_LOCAL_MEMORY_ENABLED",
        "memory",
        "로컬 메모리",
        "대화 기억을 로컬에 저장합니다.",
        Kind::Bool,
    ),
    field(
        "PLANABRAIN_LOCAL_GROUP_MEMORY_ENABLED",
        "memory",
        "그룹 메모리",
        "그룹 채팅에도 기억을 남깁니다.",
        Kind::Bool,
    ),
    field(
        "PLANABRAIN_LOCAL_MEMORY_COMPACTION_ENABLED",
        "memory",
        "기억 압축",
        "오래된 턴을 요약해 줄입니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_LOCAL_MEMORY_CONVERSATION_TTL_DAYS",
        "memory",
        "보관 기간(일)",
        "대화 기억을 남겨 두는 기간입니다.",
        Kind::Number,
        "14",
    ),
    hinted(
        "PLANABRAIN_LOCAL_MEMORY_COMPACTION_KEEP_RECENT_TURNS",
        "memory",
        "압축 시 유지 턴",
        "압축하지 않고 남길 최근 턴 수입니다.",
        Kind::Number,
        "6",
    ),
    hinted(
        "PLANABRAIN_LOCAL_MEMORY_COMPACTION_MIN_SOURCE_TURNS",
        "memory",
        "압축 시작 턴",
        "이 턴 수를 넘으면 압축합니다.",
        Kind::Number,
        "8",
    ),
    field(
        "PLANABRAIN_LOCAL_MEMORY_RETRIEVAL_LOGGING_ENABLED",
        "memory",
        "조회 로그",
        "기억 조회 과정을 로그로 남깁니다.",
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
        "GOOGLE_API_KEY",
        "google",
        "API 키",
        "Google AI Studio 키입니다.",
        Kind::Secret,
    ),
    field(
        "PLANABRAIN_GEMINI_MODEL",
        "google",
        "모델",
        "비우면 대화 모델 값을 씁니다.",
        Kind::Text,
    ),
    select(
        "PLANABRAIN_GEMINI_THINKING_LEVEL",
        "google",
        "사고 수준",
        "Gemini 전용 사고 수준입니다.",
        THINKING,
    ),
    field(
        "GOOGLE_VERTEX_EXPRESS_API_KEY",
        "vertexexpress",
        "API 키",
        "Vertex Express 키입니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_VERTEX_EXPRESS_MODEL",
        "vertexexpress",
        "모델",
        "Vertex에서 쓸 모델입니다.",
        Kind::Text,
        "gemini-2.5-flash",
    ),
    hinted(
        "PLANABRAIN_VERTEX_EXPRESS_API_VERSION",
        "vertexexpress",
        "API 버전",
        "요청 경로의 버전입니다.",
        Kind::Text,
        "v1",
    ),
    select(
        "PLANABRAIN_VERTEX_EXPRESS_THINKING_LEVEL",
        "vertexexpress",
        "사고 수준",
        "Vertex 전용 사고 수준입니다.",
        THINKING,
    ),
    field(
        "OPENROUTER_API_KEY",
        "openrouter",
        "API 키",
        "OpenRouter 키입니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_OPENROUTER_MODEL",
        "openrouter",
        "모델",
        "대화에 쓸 모델입니다.",
        Kind::Text,
        "google/gemini-3-flash-preview",
    ),
    field(
        "PLANABRAIN_OPENROUTER_IMAGE_MODEL",
        "openrouter",
        "이미지 모델",
        "이미지 분석에 쓸 모델입니다.",
        Kind::Text,
    ),
    hinted(
        "PLANABRAIN_OPENROUTER_BASE_URL",
        "openrouter",
        "기본 주소",
        "API 기본 주소입니다.",
        Kind::Text,
        "https://openrouter.ai/api/v1",
    ),
    field(
        "PLANABRAIN_OPENROUTER_ENABLE_WEB_SEARCH",
        "openrouter",
        "웹 검색",
        "OpenRouter 웹 검색을 씁니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_OPENROUTER_WEB_SEARCH_MAX_RESULTS",
        "openrouter",
        "검색 결과 수",
        "검색 한 번의 결과 수입니다.",
        Kind::Number,
        "5",
    ),
    select(
        "PLANABRAIN_OPENROUTER_WEB_SEARCH_CONTEXT_SIZE",
        "openrouter",
        "검색 문맥 크기",
        "검색 결과를 붙이는 양입니다.",
        &["low", "medium", "high"],
    ),
    hinted(
        "PLANABRAIN_OPENROUTER_PROVIDER_ORDER",
        "openrouter",
        "제공자 순서",
        "쉼표로 구분한 라우팅 순서입니다.",
        Kind::Text,
        "google-vertex,anthropic",
    ),
    field(
        "PLANABRAIN_OPENROUTER_TEMPERATURE",
        "openrouter",
        "temperature",
        "비우면 모델 기본값입니다.",
        Kind::Number,
    ),
    field(
        "PLANABRAIN_OPENROUTER_TOP_P",
        "openrouter",
        "top_p",
        "비우면 모델 기본값입니다.",
        Kind::Number,
    ),
    field(
        "OLLAMA_API_KEY",
        "ollama",
        "API 키",
        "Ollama Cloud 키입니다. 웹 검색 백엔드로도 쓰입니다.",
        Kind::Secret,
    ),
    field(
        "OLLAMA_API_KEYS",
        "ollama",
        "추가 API 키",
        "쉼표로 구분한 키 목록입니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_OLLAMA_HOST",
        "ollama",
        "호스트",
        "Ollama 서버 주소입니다.",
        Kind::Text,
        "https://ollama.com",
    ),
    hinted(
        "PLANABRAIN_OLLAMA_MODEL",
        "ollama",
        "모델",
        "Ollama 모델 이름입니다.",
        Kind::Text,
        "gemma4:31b-cloud",
    ),
    select(
        "PLANABRAIN_OLLAMA_THINKING_MODE",
        "ollama",
        "사고 수준",
        "Ollama 전용 사고 수준입니다.",
        THINKING,
    ),
    field(
        "PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH",
        "ollama",
        "웹 검색",
        "Ollama 웹 검색 도구를 씁니다.",
        Kind::Bool,
    ),
    field(
        "PLANABRAIN_OLLAMA_ENABLE_WEB_FETCH",
        "ollama",
        "웹 가져오기 도구",
        "Ollama 웹 가져오기 도구를 씁니다.",
        Kind::Bool,
    ),
    hinted(
        "PLANABRAIN_OLLAMA_TOOL_MAX_ITERATIONS",
        "ollama",
        "도구 반복 한도",
        "도구 호출을 반복하는 최대 횟수입니다.",
        Kind::Number,
        "4",
    ),
    field(
        "CEREBRAS_API_KEY",
        "cerebras",
        "API 키",
        "Cerebras 키입니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_CEREBRAS_MODEL",
        "cerebras",
        "모델",
        "Cerebras 모델 이름입니다.",
        Kind::Text,
        "gemma-4-31b",
    ),
    hinted(
        "PLANABRAIN_CEREBRAS_BASE_URL",
        "cerebras",
        "기본 주소",
        "API 기본 주소입니다.",
        Kind::Text,
        "https://api.cerebras.ai/v1",
    ),
    field(
        "PLANABRAIN_CEREBRAS_ENABLE_WEB_SEARCH",
        "cerebras",
        "웹 검색",
        "OLLAMA_API_KEY로 웹 검색을 붙입니다.",
        Kind::Bool,
    ),
    field(
        "MODEL_STUDIO_API_KEY",
        "modelstudio",
        "API 키",
        "Model Studio 키입니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_MODELSTUDIO_MODEL",
        "modelstudio",
        "모델",
        "Model Studio 모델 이름입니다.",
        Kind::Text,
        "qwen-plus",
    ),
    field(
        "PLANABRAIN_MODELSTUDIO_BASE_URL",
        "modelstudio",
        "기본 주소",
        "OpenAI 호환 API 주소입니다.",
        Kind::Text,
    ),
    field(
        "PLANABRAIN_MODELSTUDIO_ENABLE_WEB_SEARCH",
        "modelstudio",
        "웹 검색",
        "OLLAMA_API_KEY로 웹 검색을 붙입니다.",
        Kind::Bool,
    ),
    field(
        "PLANABRAIN_GEMINIWEB_API_KEY",
        "geminiweb",
        "API 키",
        "게이트웨이 접근 키입니다.",
        Kind::Secret,
    ),
    hinted(
        "PLANABRAIN_GEMINIWEB_BASE_URL",
        "geminiweb",
        "기본 주소",
        "OpenAI 호환 게이트웨이 주소입니다.",
        Kind::Text,
        "http://10.0.0.2:8083/v1",
    ),
    hinted(
        "PLANABRAIN_GEMINIWEB_MODEL",
        "geminiweb",
        "모델",
        "게이트웨이 모델 이름입니다.",
        Kind::Text,
        "gemini-3.8-flash",
    ),
    hinted(
        "PLANABRAIN_GEMINIMOCK_BASE_URL",
        "geminimock",
        "기본 주소",
        "비우면 호스트와 포트로 만듭니다.",
        Kind::Text,
        "http://127.0.0.1:43173",
    ),
    hinted(
        "GEMINI_CLI_API_HOST",
        "geminimock",
        "호스트",
        "Gemini CLI API 호스트입니다.",
        Kind::Text,
        "127.0.0.1",
    ),
    hinted(
        "GEMINI_CLI_API_PORT",
        "geminimock",
        "포트",
        "Gemini CLI API 포트입니다.",
        Kind::Number,
        "43173",
    ),
    hinted(
        "GEMINI_CLI_MODEL",
        "geminimock",
        "모델",
        "Gemini CLI에서 쓸 모델입니다.",
        Kind::Text,
        "gemini-2.5-pro",
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
        assert!(!looks_secret("PLANABRAIN_CHAT_MODEL"));
        assert_eq!(find("GOOGLE_API_KEY").map(|f| f.kind), Some(Kind::Secret));
    }
}
