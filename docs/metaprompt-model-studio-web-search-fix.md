# 메타프롬프트: modelstudio 모드 웹 검색 불가 문제 수정

아래 내용을 AI 코딩 에이전트에게 그대로 전달하면, modelstudio 프로바이더에서 시의성 질문("오늘 아침 IT뉴스 찾아봐줘" 등)에 "확인 불가" 응답만 나오는 문제가 수정됩니다.

---

## 프롬프트 본문

당신은 planabot 저장소에서 작업하는 코딩 에이전트입니다. `PLANABRAIN_AI_PROVIDER=modelstudio`에서 시의성 질문을 하면 웹 검색이 수행되지 않고 항상 "확인 불가. 최신 정보를 검색 결과와 출처로 확인하지 못했습니다."라는 고정 응답이 반환됩니다. 원인은 이미 분석되어 있으니 아래 수정 지시를 따르십시오.

### 1. 확인된 원인

원인은 두 가지가 겹쳐 있으며, 두 번째가 본질적인 버그입니다.

원인 A. 웹 검색 플래그 기본값이 꺼져 있습니다.
- `planabrain/src/config/settings.ts:201-204`에서 `PLANABRAIN_MODELSTUDIO_ENABLE_WEB_SEARCH`의 기본값이 `false`입니다. cerebras는 같은 위치(L198)에서 기본값 `true`입니다.
- 플래그가 꺼지면 `isSearchToolAvailable()`(`planabrain/src/integrations/gemini/chat.ts:552-556`)이 false를 반환하고, 시스템 프롬프트가 `SEARCH_DISABLED_PROMPT`(`planabrain/src/config/systemPrompt.ts:39-43`)로 바뀌며, `buildWebTools()`가 undefined를 반환해 요청 페이로드에 `tools`가 실리지 않습니다.

원인 B. 툴 검색 결과가 인용으로 승격되지 않아 fail-closed 게이트에 걸립니다.
- `planabrain/src/chat/webSearchAnswer.ts:126-131`의 게이트는 시의성 질문에서 `invocation.searchUsed`가 true이고 `invocation.citations`가 비어 있지 않아야 답변을 통과시킵니다. 실패 시 `CURRENT_INFORMATION_UNAVAILABLE`(L25-30) 고정 문구를 반환합니다.
- 그런데 `searchUsed`와 `citations`를 채우는 코드는 OpenRouter 경로(`chat.ts:1252-1303`의 `extractOpenAIResult`, annotations 기반)뿐입니다.
- modelstudio, cerebras, ollama의 tool-calling 루프는 `executeOllamaToolCall`(`chat.ts:960-996`) 결과를 대화 메시지에만 push하고 인용으로 변환하지 않습니다. 최종 반환값(`chat.ts:513-521`, `chat.ts:418-426`, `chat.ts:645-649` 부근)에도 `citations`, `searchUsed`가 실리지 않습니다.
- 따라서 플래그를 켜서 web_search 툴이 실제로 실행되어도 게이트가 답변을 폐기하고 같은 "확인 불가" 문구가 나옵니다. cerebras와 ollama도 같은 구조이므로 동일 증상이 잠재해 있습니다.

참고로 Model Studio 자체의 `enable_search` 파라미터(요청 본문에 `enable_search: true` + `search_options`)는 이 문제의 해법이 아닙니다. OpenAI 호환 프로토콜에서는 검색 출처가 응답에 반환되지 않으므로, 인용을 요구하는 위 게이트를 통과할 수 없습니다. 기존 function-tool 검색 경로(`web_search`/`web_fetch`, Ollama 검색 API 백엔드)를 사용해야 합니다.

### 2. 수정 지시

1. `planabrain/src/config/settings.ts:201-204`
   - `PLANABRAIN_MODELSTUDIO_ENABLE_WEB_SEARCH` 기본값을 cerebras와 같이 `true`로 변경하십시오.
   - `.env.example`(L62-68 부근)과 `README.md`(L150-163, 227-230 부근)의 기본값 안내를 함께 갱신하십시오.
2. 툴 검색 결과를 인용으로 승격하는 경로를 신설하십시오. 이것이 핵심 수정입니다.
   - `executeOllamaToolCall`(`chat.ts:960-996`)이 `web_search` 결과에서 URL, 제목 등 인용에 필요한 정보를 함께 반환하도록 바꾸거나, `WebToolPolicy`(`planabrain/src/integrations/webToolPolicy.ts`, `addSearchResult` L22-24 부근)에 검색 결과 수집 API를 추가해 루프 밖에서 회수할 수 있게 하십시오. 두 방식 중 기존 코드 변경이 적은 쪽을 고르되, 반환 타입 변경이 다른 호출부를 깨뜨리지 않는지 확인하십시오.
   - `invokeModelStudioChat`(`chat.ts:450-542`), `invokeCerebrasChat`(`chat.ts:375-448` 부근), `invokeOllamaChat`(`chat.ts:588-663`)의 최종 반환값에 수집한 `citations`와, web_search 툴이 1회 이상 실행되었을 때의 `searchUsed: true`를 실으십시오. 기존 `WebCitation` 타입(chat.ts 상단)을 그대로 사용하고, OpenRouter 경로가 만드는 형태와 필드 구성을 맞추십시오.
   - `invokeChatWithMetadata`(`chat.ts:125-177`)의 이어쓰기 병합 로직은 이미 있으므로 수정하지 마십시오. 다만 이어쓰기 재요청 시 citations가 유실되지 않는지는 확인하십시오.
   - web_search가 실행되었으나 결과가 0건인 경우에는 `searchUsed: true`이되 citations는 비게 두어, 게이트가 의도대로 "확인 불가"를 반환하게 두십시오. 검색 없이 답한 것과 검색했으나 못 찾은 것을 코드에서 구분하지 마십시오. 게이트 조건이 이미 그 역할을 합니다.
3. `webSearchAnswer.ts:126-131`의 게이트 자체는 완화하지 마십시오. fail-closed 동작은 의도된 설계입니다. 참고로 `isExplicitSearchRequest()`(L328-334)는 현재 호출부가 없는 사장 코드인데, 이번 작업 범위에서는 건드리지 말고 그대로 두십시오.
4. 테스트
   - `planabrain/src/integrations/searchGrounding.test.ts`의 픽스처는 전부 `aiProvider: "openrouter"`라 이 버그를 잡지 못했습니다. modelstudio(가능하면 cerebras도) 픽스처를 추가해 다음을 검증하십시오: 툴 루프에서 web_search가 실행되면 반환값에 `searchUsed: true`와 citations가 실린다, 검색 결과 0건이면 citations가 빈다.
   - `planabrain/src/integrations/searchToolAvailability.test.ts`에서 modelstudio 기본값 변경(true)을 반영하십시오. `OLLAMA_API_KEY`가 없으면 여전히 false여야 합니다.
   - 네트워크 호출은 기존 테스트 패턴대로 목으로 대체하십시오.

### 3. 제약과 규칙

- AGENTS.md의 규칙을 따르십시오. Conventional Commits, secrets 커밋 금지, 신규 또는 변경된 config key의 `.env.example` 반영.
- 코드에 주석과 이모지를 넣지 마십시오.
- 의존성을 추가하지 마십시오.
- `.env` 파일은 로컬 사용자 소유이므로 수정하지 마십시오. 대신 결과 보고에 `PLANABRAIN_MODELSTUDIO_ENABLE_WEB_SEARCH` 관련 안내를 포함하십시오. 기본값이 true로 바뀌므로 `.env`에 `=0`으로 남아 있으면 검색이 계속 꺼진다는 점을 알려야 합니다.
- 검색 백엔드는 `OLLAMA_API_KEY`(`POST {ollamaSearchHost}/api/web_search`)를 재사용하는 기존 구조를 유지하십시오. 새 검색 백엔드를 도입하지 마십시오.

### 4. 검증

`planabrain/` 디렉터리에서 다음을 모두 통과해야 합니다.

```bash
npm run typecheck
npm test
npm run build
```

실제 동작 확인은 다음과 같이 수행합니다. API 키는 실행 환경에서 주입하며 어떤 파일에도 기록하지 않습니다.

```bash
cd planabrain
PLANABRAIN_AI_PROVIDER=modelstudio \
MODEL_STUDIO_API_KEY=... \
OLLAMA_API_KEY=... \
npx tsx src/cli/index.ts ask "오늘 아침 IT뉴스 찾아봐줘"
```

키가 없어 실제 호출을 못 했다면 그 사실을 결과 보고에 명시하십시오.

### 5. 완료 기준

- modelstudio 모드에서 시의성 질문을 하면 web_search 툴이 실행되고, 출처가 포함된 실제 답변이 반환된다.
- 검색 결과가 전혀 없을 때만 기존 "확인 불가" 문구가 나온다.
- cerebras, ollama 모드에서도 동일하게 citations와 searchUsed가 반환값에 실린다.
- OpenRouter 경로의 기존 동작에 변화가 없다.
- typecheck, test, build가 모두 통과한다.
