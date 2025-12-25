# planabrain (TypeScript) 구현 보고서

## 1) 프로젝트 개요

이 프로젝트는 Node.js + TypeScript 기반의 CLI 형태로 시작한 LLM 어시스턴트입니다.

- `ingest`: 로컬 디렉터리 문서를 임베딩하여 `.planabrain/index.json`에 저장 (간단한 파일 기반 벡터 인덱스)
- `ask`: 현재는 **웹 검색 기반 답변**이 기본 경로이며, **유저별 대화 메모리**를 포함해 “챗봇처럼” 동작하도록 구성
- RAG(로컬 문서 기반 검색-증강)는 구현되어 있으며, 현재 CLI의 `ask` 기본 경로는 웹검색이지만, `src/rag/answer.ts`로 언제든 다시 연결 가능

## 2) 기술/스택

### 런타임/언어

- Node.js (ESM, `"type": "module"`)
- TypeScript (`tsconfig.json`은 `module: "NodeNext"`, `target: "ES2022"`)
  - `tsconfig.json:1`
- `tsx`로 개발 실행 (`npm run dev`)
  - `package.json:7`

### 주요 라이브러리

- LangChain 코어: `@langchain/core`
  - 메시지 타입(`HumanMessage`, `AIMessage`, `SystemMessage`)에 사용
    - `src/chat/webSearchAnswer.ts:1`
- Gemini 연동(채팅/임베딩): `@langchain/google-genai`
  - 채팅 모델: `ChatGoogleGenerativeAI` (`src/integrations/gemini/chat.ts:1`)
  - 임베딩: `GoogleGenerativeAIEmbeddings` (`src/integrations/gemini/embeddings.ts:1`)
- Google Generative AI JS SDK: `@google/generative-ai`
  - Gemini의 웹검색 툴(`googleSearch`) 스키마 구성을 위해 사용
  - 실제 호출은 LangChain을 통해 이뤄지고, 툴 구조만 전달합니다 (`src/integrations/googleSearch/retrievalTool.ts:1`)
- 환경변수 로딩: `dotenv`
  - CLI 진입점에서 `import "dotenv/config";`로 즉시 로드 (`src/cli/index.ts:1`)

## 3) 디렉터리/모듈 구조

`src/` 내부 구조는 기능 단위로 분리되어 있습니다.

- `src/cli/*`: CLI 엔트리/파서/커맨드
  - `src/cli/index.ts`: 실행 진입점
  - `src/cli/parse.ts`: `ingest|ask` 파싱
  - `src/cli/commands/*.ts`: 커맨드 핸들러
- `src/config/settings.ts`: 환경변수 → 런타임 설정 로딩
- `src/integrations/*`: 외부 서비스 연동 (Gemini Chat/Embeddings, Google Search Tool)
- `src/loaders/*`: 문서 로더 (디렉터리 로드)
- `src/rag/*`: RAG 인덱싱/답변/컨텍스트 구성
- `src/retrieval/*`: 로컬 벡터 인덱스 저장/검색(코사인 유사도)
- `src/memory/*`: 유저별 대화 메모리 저장소
- `src/chat/*`: “채팅” 단위의 답변 오케스트레이션(현재는 웹검색 응답)

## 4) 설정(환경변수)과 설정 로딩

환경변수는 `src/config/settings.ts`에서 `Settings`로 모읍니다 (`src/config/settings.ts:59`).

필수:

- `GOOGLE_API_KEY` (또는 `GEMINI_API_KEY`)
  - `src/config/settings.ts:71-74`

모델/인덱스:

- `PLANABRAIN_GEMINI_MODEL` (기본: `gemini-3-flash-preview`)
  - `src/config/settings.ts:91`
- `PLANABRAIN_GEMINI_EMBEDDING_MODEL` (기본: `gemini-embedding-001`)
  - `src/config/settings.ts:92-93`
- `PLANABRAIN_INDEX_PATH` (기본: `.planabrain/index.json`)
  - `src/config/settings.ts:76`

시스템 프롬프트:

- `PLANABRAIN_SYSTEM_PROMPT` (없으면 코드에 내장된 기본 프롬프트 사용)
  - `src/config/settings.ts:95`

대화 메모리:

- `PLANABRAIN_MEMORY_ENABLED` (기본 `true`, `0` 또는 `false`면 비활성화)
  - `src/config/settings.ts:77-82`
- `PLANABRAIN_MEMORY_MAX_MESSAGES` (기본 `20`, 0이면 저장/주입 안 함)
  - `src/config/settings.ts:83-84`
- `PLANABRAIN_MEMORY_DIR` (기본: `dirname(indexPath) + "/memory"`)
  - `src/config/settings.ts:86-87`

CLI 유저 식별:

- `PLANABRAIN_USER_ID` (CLI에서 메모리 파일을 구분하기 위한 키)
  - `src/cli/commands/ask.ts:10`

## 5) LangChain 기반 LLM 호출 핵심 로직

이 프로젝트는 “LangChain 메시지 → Gemini 모델 호출”을 기본 패턴으로 사용합니다.

### 5.1 채팅 모델 생성

- `createChatModel(settings)`가 `ChatGoogleGenerativeAI` 인스턴스를 생성합니다.
  - `src/integrations/gemini/chat.ts:5`
- 모델명은 `settings.chatModel`에서 가져오며, 현재 `temperature: 1.0`입니다.
  - `src/integrations/gemini/chat.ts:6-10`

### 5.2 메시지 구성

- 시스템 프롬프트는 `SystemMessage(settings.systemPrompt)`로 주입됩니다.
  - 웹검색: `src/chat/webSearchAnswer.ts:27`
  - RAG: `src/rag/answer.ts:45`
- 사용자의 입력은 `HumanMessage(question)`로 전달됩니다.
  - 웹검색: `src/chat/webSearchAnswer.ts:31`
  - RAG: `src/rag/answer.ts:46-48`

### 5.3 툴(웹검색) 바인딩

- 웹검색 모드에서는 모델에 “구글 검색 툴”을 바인딩합니다.
  - `createGoogleSearchTool()` → `{ googleSearch: {} }`
    - `src/integrations/googleSearch/retrievalTool.ts:5-7`
  - `bindTools([tool])`로 LLM에 연결
    - `src/chat/webSearchAnswer.ts:14`

이때 실제 검색 엔진은 Google Search이며, Gemini의 내장 툴 호출 방식으로 동작합니다.

## 6) RAG 구현(로컬 문서 인덱싱 + 검색 + 컨텍스트 주입)

RAG는 다음 3단계로 구현되어 있습니다.

### 6.1 인덱싱(ingest)

엔트리:

- CLI 커맨드: `runIngestCommand` (`src/cli/commands/ingest.ts:3`)
- 실제 인덱싱 함수: `ingestDirectory` (`src/rag/ingest.ts:10`)

문서 로딩:

- `loadSourceDirectory(sourceDir)`가 디렉터리 안의 파일을 로드합니다.
  - `src/loaders/sourceDirectory.ts:6`
- `DirectoryLoader` + `TextLoader` 기반이며, `.md/.txt/.ts/...` 여러 확장자를 텍스트로 로드합니다.
  - `src/loaders/sourceDirectory.ts:7-21`

청킹:

- `RecursiveCharacterTextSplitter` 사용 (`chunkSize: 1000`, `chunkOverlap: 150`)
  - `src/rag/ingest.ts:13-18`

임베딩:

- `createEmbeddings(settings)`가 `GoogleGenerativeAIEmbeddings`를 생성합니다.
  - `src/integrations/gemini/embeddings.ts:5-9`
- `embedDocuments(texts)`로 청크 임베딩 벡터를 생성합니다.
  - `src/rag/ingest.ts:27`

검증(안정성):

- 청크 수와 임베딩 수 불일치 검사 (`Embedding count mismatch`)
  - `src/rag/ingest.ts:29-33`
- 임베딩 차원 검증 및 청크 간 차원 일관성 검사
  - `src/rag/ingest.ts:35-56`

저장:

- 인덱스 스키마(`StoredIndex`)는 `{ version, embeddingModel, embeddingDimension, chunks[] }` 형태입니다.
  - `src/retrieval/types.ts:8-13`
- `saveIndex(indexPath, index)`가 디렉터리를 만들고 JSON으로 저장합니다.
  - `src/retrieval/indexStore.ts:5-8`

### 6.2 검색(retrieval)

질문 임베딩:

- `embeddings.embedQuery(question)`로 쿼리 벡터 생성
  - `src/rag/answer.ts:22`

모델/차원 불일치 방지:

- 인덱스가 만들어진 임베딩 모델과 현재 설정이 다르면 즉시 에러로 중단
  - `src/rag/answer.ts:15-19`
- 쿼리 임베딩 차원과 인덱스 차원이 다르면 즉시 에러로 중단
  - `src/rag/answer.ts:23-33`

Top-K 선택:

- `topKSimilarChunks({ queryEmbedding, chunks, k: 4 })`
  - `src/rag/answer.ts:35-39`
- 내부는 코사인 유사도로 정렬 후 상위 K개를 반환합니다.
  - `src/retrieval/search.ts:6-22`
- `cosineSimilarity(a, b)`는 차원 불일치시 에러를 던집니다.
  - `src/retrieval/similarity.ts:1-4`

### 6.3 컨텍스트 구성 + 답변 생성

컨텍스트 텍스트 구성:

- `buildContext(chunks)`는 `SOURCE: <path>\n<chunk>` 포맷으로 합칩니다.
  - `src/rag/context.ts:3-4`

LLM 호출:

- `answerQuestion`이 `SystemMessage(settings.systemPrompt)` + `HumanMessage`로 호출합니다.
  - `src/rag/answer.ts:44-48`

현재 `answerQuestion`은 “RAG 전용”으로 컨텍스트를 만들어 주입합니다.
CLI의 `ask`는 웹검색 응답을 기본 사용하지만, 필요 시 `src/cli/commands/ask.ts`에서 호출을 RAG로 다시 바꿀 수 있습니다.

## 7) 웹검색 기반 답변(현재 ask 기본 경로)

엔트리:

- CLI 커맨드: `runAskCommand` (`src/cli/commands/ask.ts:4`)
- 웹검색 답변 함수: `answerWithWebSearch` (`src/chat/webSearchAnswer.ts:8`)

핵심 흐름:

1. `createGoogleSearchTool()`로 툴 생성 (`{ googleSearch: {} }`)
   - `src/integrations/googleSearch/retrievalTool.ts:5-7`
2. `createChatModel(settings).bindTools([tool])`로 툴 바인딩
   - `src/chat/webSearchAnswer.ts:13-14`
3. `SystemMessage(systemPrompt)` + (메모리 히스토리) + `HumanMessage(question)`로 `invoke`
   - `src/chat/webSearchAnswer.ts:26-32`

## 8) 유저별 대화 메모리(챗봇처럼 동작)

목표는 “유저별로 대화 문맥을 유지”하는 것입니다.
현재 구현은 외부 DB 없이, **파일 기반 per-user 저장소**입니다.

저장 위치(기본):

- `settings.indexPath`가 `.planabrain/index.json`이면,
  - 메모리 디렉터리 기본값은 `.planabrain/memory/` 입니다 (`src/config/settings.ts:86-87`)
  - 유저별 파일은 `.planabrain/memory/<userId>.json` 입니다 (`src/memory/userMemoryStore.ts:21-23`)

저장/로드 API:

- `loadUserMemory({ memoryDir, userId, maxMessages })`
  - `src/memory/userMemoryStore.ts:25`
  - 파일이 없으면 빈 배열 반환(ENOENT 처리) (`src/memory/userMemoryStore.ts:34-37`)
- `appendUserMemory({ memoryDir, userId, maxMessages, messages })`
  - `src/memory/userMemoryStore.ts:60`
  - 기존 + 신규를 합쳐 `maxMessages`만 유지 (`src/memory/userMemoryStore.ts:72-78`)

웹검색 답변에 메모리 주입:

- 히스토리를 읽고, 역할에 따라 `AIMessage`/`HumanMessage`로 변환해 `invoke`에 포함합니다.
  - `src/chat/webSearchAnswer.ts:17-31`
- 답변 생성 후, `(질문, 답변)`을 유저 메모리에 append합니다.
  - `src/chat/webSearchAnswer.ts:36-46`

CLI에서 유저 구분:

- `PLANABRAIN_USER_ID`를 `userId`로 전달합니다 (기본값 `cli`)
  - `src/cli/commands/ask.ts:10-12`

텔레그램 봇 연동 시:

- 텔레그램의 `from.id`(정수)를 `String(from.id)`로 변환해서 `userId`로 넘기면 유저별 메모리 분리가 됩니다.

## 9) 현재 구현 상태 요약

- 동작 경로(기본): `ask` = 웹검색 + 유저별 메모리
  - `src/cli/commands/ask.ts:4-13`
- RAG는 `ingest` + `answerQuestion`으로 구현되어 있으며, 로컬 문서를 벡터화해 JSON 인덱스로 저장하고 코사인 유사도로 검색합니다.
- 시스템 프롬프트(프라나 말투)는 `settings.systemPrompt`로 모든 응답 경로에 주입됩니다.

