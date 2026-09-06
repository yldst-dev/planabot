# 메타프롬프트: Plana Brain에 Alibaba Cloud Model Studio 프로바이더 추가

아래 내용을 AI 코딩 에이전트에게 그대로 전달하면, planabrain에서 Alibaba Cloud Model Studio를 챗 모델 프로바이더로 테스트할 수 있는 환경이 구성됩니다.

---

## 프롬프트 본문

당신은 planabot 저장소에서 작업하는 코딩 에이전트입니다. Plana Brain(planabrain)에 Alibaba Cloud Model Studio를 새 챗 모델 프로바이더로 추가하여, 환경변수로 API 키만 넣으면 바로 테스트할 수 있게 만드십시오.

### 1. 프로젝트 배경

- 이 저장소는 Rust `core`와 TypeScript CLI `planabrain`으로 구성됩니다. LLM 프로바이더 코드는 전부 `planabrain`(Node 20+, ESM)에 있으며, Rust 쪽에는 프로바이더 코드가 없습니다. 이번 작업에서 Rust 코드는 수정하지 않습니다.
- 챗 프로바이더 분기는 `planabrain/src/integrations/gemini/chat.ts`의 `invokeChatOnce()`(L181-220 부근)에 있는 if-체인입니다. 파일명이 `gemini/chat.ts`이지만 모든 프로바이더의 허브입니다.
- OpenAI 호환 프로바이더는 이미 3종(geminimock, openrouter, cerebras) 있으며, 공용 헬퍼가 준비되어 있습니다.
  - `invokeOpenAICompatibleChat()` (chat.ts L1000 부근): 툴 콜 없는 단발 호출용
  - `postOpenAIChatChoice()` (chat.ts L1032 부근): tool-calling 루프용, cerebras가 사용
- 설정은 `planabrain/src/config/settings.ts`의 `Settings` 타입(L35-83 부근)과 `loadSettings()`(L85-330 부근)가 담당합니다. 프로바이더 선택은 `resolveAiProvider()`(L332-380 부근)의 문자열 유니온입니다.
- Cerebras 구현(`invokeCerebrasChat`, chat.ts L351-437 부근)이 이번 작업의 가장 좋은 템플릿입니다. tool-calling 루프, rate-limit 재시도, 에러 분류가 모두 붙어 있습니다.

### 2. 추가할 프로바이더 사양

- 프로바이더 이름: `modelstudio`. `resolveAiProvider()`에서 별칭 `alibaba`, `dashscope`, `qwen`도 허용하십시오.
- API 방식: OpenAI Chat Completions 호환.
- 기본 base URL: `https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1`
  - 챗 엔드포인트는 `${baseUrl}/chat/completions`로 조합합니다.
- 환경변수:
  - `MODEL_STUDIO_API_KEY` (필수): 이 키 하나만 있으면 동작해야 합니다. `Authorization: Bearer` 헤더로 전달합니다.
  - `PLANABRAIN_MODELSTUDIO_MODEL` (선택): 미지정 시 기본값 `qwen-plus`. 공용 `PLANABRAIN_CHAT_MODEL` 폴백 순서는 기존 프로바이더(settings.ts L275-297 부근의 삼항 체인)와 동일하게 맞추십시오.
  - `PLANABRAIN_MODELSTUDIO_BASE_URL` (선택): base URL 오버라이드.
- 임베딩은 범위 밖입니다. `resolveEmbeddingProvider()`가 미지정 시 google로 파생하는 기존 동작을 그대로 두고, embedding provider 유니온에는 추가하지 마십시오.
- 이미지 입력은 지원하지 않는 것으로 처리하십시오. google, geminimock과 같은 방식으로 명시적으로 throw 하면 됩니다(chat.ts L189-191 패턴).
- 웹 검색 툴: 기본 비활성. `PLANABRAIN_MODELSTUDIO_ENABLE_WEB_SEARCH=true`일 때만 cerebras와 동일한 `web_search`/`web_fetch` function-tool 루프(`postOpenAIChatChoice` + `buildWebTools` + `executeOllamaToolCall`)를 사용하십시오. cerebras처럼 검색 백엔드로 `OLLAMA_API_KEY`를 재사용하는 구조임을 유의하고, `isSearchToolAvailable()`(chat.ts L439-453 부근)에도 분기를 추가하십시오. 비활성 시에는 툴 없이 `postOpenAIChatChoice` 단발 호출 또는 `invokeOpenAICompatibleChat`을 사용하면 됩니다.

### 3. 수정 파일 체크리스트

1. `planabrain/src/config/settings.ts`
   - `Settings.aiProvider` 유니온에 `modelstudio` 추가 (L36-42 부근)
   - `Settings`에 `modelStudioApiKey`, `modelStudioBaseUrl`, (웹 검색을 넣는 경우) `modelStudioWebSearchEnabled` 필드 추가 (cerebras 필드 L49-51 패턴)
   - `resolveAiProvider()`: 반환 타입, 별칭 분기, 미지원 값 에러 메시지 3곳 모두 갱신
   - `loadSettings()`: env 읽기, `modelstudio` 선택 시 `MODEL_STUDIO_API_KEY` 부재면 throw(L98-122 패턴), 리턴 객체, `chatModel` 삼항 체인 2곳
   - `resolveModelStudioBaseUrl()` 신규 작성: `resolveCerebrasBaseUrl()`(L465-475)을 복사하되 주의점 하나 — 기존 resolver는 `/v1` 접미사를 강제하지만 Model Studio의 경로는 `/compatible-mode/v1`입니다. 미지정 시 위 기본 URL을 그대로 쓰고, 오버라이드 값에는 `/compatible-mode/v1` 접미사가 없으면 붙이는 방식으로 구현하십시오. `normalizeApiBaseUrl()`(L567)의 http(s) 검증은 유지합니다.
2. `planabrain/src/integrations/gemini/chat.ts`
   - `invokeChatOnce()`에 `modelstudio` 분기 추가
   - `invokeModelStudioChat()` 구현: `invokeCerebrasChat`을 템플릿으로 복사해 이름, 설정 필드, 에러 providerName만 바꾸는 수준을 목표로 하십시오. `ProviderApiError` 분류(`classifyHttpStatus`), `withRateLimitRetry`, `fetchWithTimeout` 등 기존 인프라를 그대로 재사용합니다.
   - `isSearchToolAvailable()` 분기 추가
3. `planabrain/.env.example`
   - 새 환경변수 3종을 주변 프로바이더들과 같은 형식으로 추가하십시오. AGENTS.md가 신규 config key 추가 시 `.env.example` 갱신을 요구합니다.
4. `README.md`
   - `## AI Provider` 섹션(L124-155 부근)에 Model Studio 항목과 최소 설정 예시를 추가하고, `## 주요 환경변수` 섹션에도 새 변수를 추가하십시오. Cerebras는 README에 문서화가 누락된 상태이므로 선례로 삼지 마십시오.
5. 테스트
   - `planabrain/src/integrations/searchToolAvailability.test.ts`: modelstudio 케이스(웹 검색 on/off) 추가
   - `planabrain/src/integrations/searchGrounding.test.ts`: `settingsFor` 헬퍼에 새 Settings 필드 반영
   - base URL resolver의 접미사 처리(미지정, 접미사 없는 오버라이드, 접미사 있는 오버라이드)를 검증하는 단위 테스트를 기존 테스트 파일 패턴대로 추가하십시오.

### 4. 제약과 규칙

- AGENTS.md의 규칙을 따르십시오. Conventional Commits, secrets 커밋 금지, 신규 config key의 `.env.example` 반영.
- 코드에 주석과 이모지를 넣지 마십시오.
- 의존성을 추가하지 마십시오. Node 내장 fetch 기반의 기존 헬퍼로 충분합니다.
- 사용자에게 보이는 문자열이 필요하면 기존 프라나 톤 한국어 규칙을 따르십시오.
- 스트리밍은 구현하지 마십시오. 기존 프로바이더와 동일하게 단발 요청이며, `finish_reason=length` 이어쓰기는 `invokeChatWithMetadata`가 이미 공통 처리합니다.

### 5. 검증

`planabrain/` 디렉터리에서 다음을 모두 통과해야 합니다.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

실제 호출 테스트는 다음과 같이 수행합니다. API 키는 실행 환경에서 주입하며 어떤 파일에도 기록하지 않습니다.

```bash
cd planabrain
PLANABRAIN_AI_PROVIDER=modelstudio \
MODEL_STUDIO_API_KEY=... \
npx tsx src/cli/index.ts ask "안녕, 자기소개 해줘"
```

키가 없어 실제 호출을 못 했다면 그 사실을 결과 보고에 명시하고, 위 명령을 테스트 절차로 안내하십시오.

### 6. 완료 기준

- `PLANABRAIN_AI_PROVIDER=modelstudio`와 `MODEL_STUDIO_API_KEY`만 설정하면 `ask` 서브커맨드가 Model Studio(qwen-plus)로 응답한다.
- `PLANABRAIN_MODELSTUDIO_MODEL`, `PLANABRAIN_MODELSTUDIO_BASE_URL`로 모델과 엔드포인트를 바꿀 수 있다.
- 키 없이 `modelstudio`를 선택하면 다른 프로바이더와 동일한 형식의 명확한 에러가 발생한다.
- typecheck, test, build가 모두 통과하고, `.env.example`과 README가 갱신되어 있다.
- 기존 프로바이더의 동작 변화가 없다.
