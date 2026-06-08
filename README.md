# planabot

텔레그램에서 Hitomi 갤러리 조회, 링크 정리, 프라나 AI 응답을 함께 처리하는 봇입니다.

- Rust 봇 본체: `core/`
- TypeScript 기반 planabrain CLI: `planabrain/`
- 운영 배포: GHCR 이미지 + `docker-compose.prod.yml`

## 주요 기능

- Hitomi 갤러리 조회
- YouTube, Spotify, Apple Music 추적 파라미터 정리
- X/Twitter → `fxtwitter`, Instagram → `vxinstagram` 변환
- Threads 포스트 링크 추적 파라미터 정리
- 일정/타이머 등록과 예약 메시지 전송
- `프라나야` 호출 기반 AI 응답
- 그룹 채팅 답장 체인 기준 맥락 유지
- 이미지 입력 분석
- 웹 검색 기반 최신 정보 응답
- 장기 메모리와 그룹 공용 메모리
- 응답 잘림 감지 후 자동 이어쓰기
- OpenRouter, Vertex Express, Ollama Cloud 등 다중 provider 지원

## 저장소 구조

```text
core/                    Rust 텔레그램 봇
planabrain/              TypeScript CLI, 메모리, 검색, provider 연동
scripts/                 로컬 빌드/배포 보조 스크립트
docker-compose.yml       로컬 개발용 compose
docker-compose.prod.yml  운영 배포용 compose
deploy.sh                서버 재배포 스크립트
```

## 빠른 시작

1. `.env.example`을 복사해 `.env`를 만듭니다.

```bash
cp .env.example .env
```

2. 최소 필수값을 채웁니다.

```dotenv
TELEGRAM_API_TOKEN=123456:ABC-YourRealToken
PLANABRAIN_AI_PROVIDER=vertexexpress
GOOGLE_VERTEX_EXPRESS_API_KEY=YOUR_VERTEX_EXPRESS_API_KEY_HERE
PLANABRAIN_ALLOWED_CHAT_IDS=-1001234567890
PLANABRAIN_ALLOWED_USER_IDS=123456789
```

3. planabrain 의존성을 설치합니다.

```bash
cd planabrain
npm ci
cd ..
```

4. 봇을 실행합니다.

```bash
cargo run --release
```

## 개발 명령

### Rust

```bash
cargo fmt
cargo clippy -- -D warnings
cargo test
cargo run --release
```

### planabrain

```bash
cd planabrain
npm run typecheck
npm run build
npm run dev
```

## 텔레그램 사용 방법

- Hitomi 조회
  - 전체 채팅: `!<ID>`
  - 개인 채팅: `<ID>`
  - 그룹: `@봇계정 <ID>`
- 명령어
  - `/start`
  - `/ping`
  - `/version`
  - `/token`
  - `/memoryreset`
  - `/schedule`
  - `/timer`
  - `/groupinfo`
- AI 호출
  - `프라나야`로 시작하는 메시지
  - 일반 텍스트, 캡션, 답장, 답장 이미지까지 함께 반영
- 일정/타이머
  - `/schedule`로 등록된 일정 확인
  - `/schedule 내일 오후 3시 회의 준비`처럼 일정 등록
  - `/timer 10분 물 확인`처럼 타이머 등록
  - 자연어로 일정 취소와 목록 확인

## 프라나 AI 동작

- 허용된 채팅과 사용자에서만 동작합니다.
- 개인 채팅에서는 Telegram draft 상태 표시를 우선 사용하고, 불가하면 typing 으로 폴백합니다.
- 그룹에서는 프라나 응답에 달린 답장을 같은 대화 체인으로 이어받습니다.
- 이미지가 있으면 planabrain 쪽에서 직접 멀티모달 입력으로 처리합니다.
- 최신 정보가 필요하면 provider별 웹 검색 경로를 사용합니다.
- 응답이 길이 제한으로 끊기면 자동으로 이어서 받아 한 번 더 합칩니다.
- 최종 텔레그램 전송 전에는 1024토큰 기준으로 한 번 더 정리해 문장 중간 출처 삽입과 과도한 장문 응답을 줄입니다.
- 내부 메타 문장이나 reasoning 누출은 후처리에서 제거합니다.

## AI Provider

### Google

- `PLANABRAIN_AI_PROVIDER=google`
- 필수: `GOOGLE_API_KEY`

### Vertex Express

- `PLANABRAIN_AI_PROVIDER=vertexexpress`
- 필수: `GOOGLE_VERTEX_EXPRESS_API_KEY` 또는 `VERTEX_EXPRESS_API_KEY`
- 기본 모델 예시: `gemini-3-flash-preview`

### GeminiMock

- `PLANABRAIN_AI_PROVIDER=geminimock`
- 필수: `PLANABRAIN_GEMINIMOCK_BASE_URL` 또는 `GEMINI_CLI_API_HOST`, `GEMINI_CLI_API_PORT`

### OpenRouter

- `PLANABRAIN_AI_PROVIDER=openrouter`
- 필수: `OPENROUTER_API_KEY`
- 권장 검색 방식: `openrouter:web_search` server tool

### Ollama Cloud

- `PLANABRAIN_AI_PROVIDER=ollama`
- 필수: `OLLAMA_API_KEY` 또는 `OLLAMA_API_KEYS`
- 권장 모델 예시: `gemma4:31b-cloud`
- 검색: `web_search`, `web_fetch`
- 여러 API 키를 등록하면 쿼타 제한 시 다음 키로 재시도합니다.

## 주요 환경변수

### 공통

- `TELEGRAM_API_TOKEN`
- `PLANABRAIN_ENABLED`
- `PLANABOT_TELEGRAM_DRAFT_ENABLED`
- `PLANABRAIN_AI_PROVIDER`
- `PLANABRAIN_CHAT_MODEL`
- `PLANABRAIN_CHAT_MAX_OUTPUT_TOKENS`
- `PLANABRAIN_DELIVERY_MAX_OUTPUT_TOKENS`
- `PLANABRAIN_DELIVERY_REWRITE_ENABLED`
- `PLANABRAIN_CHAT_THINKING_MODE`
- `PLANABRAIN_EMBEDDING_MODEL`
- `PLANABRAIN_ALLOWED_CHAT_IDS`
- `PLANABRAIN_ALLOWED_USER_IDS`

### Google / Vertex

- `GOOGLE_API_KEY`
- `GOOGLE_VERTEX_EXPRESS_API_KEY`
- `VERTEX_EXPRESS_API_KEY`
- `PLANABRAIN_VERTEX_EXPRESS_API_VERSION`
- `PLANABRAIN_VERTEX_EXPRESS_MODEL`
- `PLANABRAIN_VERTEX_EXPRESS_EMBEDDING_MODEL`
- `PLANABRAIN_VERTEX_EXPRESS_THINKING_LEVEL`
- `gemini-3-flash-preview`에서는 `PLANABRAIN_VERTEX_EXPRESS_THINKING_LEVEL=off`가 사실상 `MINIMAL`로 적용됩니다.

### GeminiMock

- `PLANABRAIN_GEMINIMOCK_BASE_URL`
- `GEMINI_CLI_API_HOST`
- `GEMINI_CLI_API_PORT`
- `GEMINI_CLI_MODEL`

### OpenRouter

- `OPENROUTER_API_KEY`
- `PLANABRAIN_OPENROUTER_MODEL`
- `PLANABRAIN_OPENROUTER_BASE_URL`
- `PLANABRAIN_OPENROUTER_SITE_URL`
- `PLANABRAIN_OPENROUTER_APP_NAME`
- `PLANABRAIN_OPENROUTER_ENABLE_WEB_SEARCH`
- `PLANABRAIN_OPENROUTER_WEB_SEARCH_MAX_RESULTS`
- `PLANABRAIN_OPENROUTER_WEB_SEARCH_MAX_TOTAL_RESULTS`
- `PLANABRAIN_OPENROUTER_WEB_SEARCH_CONTEXT_SIZE`

### Ollama

- `OLLAMA_API_KEY`
- `OLLAMA_API_KEYS`
- `PLANABRAIN_OLLAMA_HOST`
- `PLANABRAIN_OLLAMA_SEARCH_HOST`
- `PLANABRAIN_OLLAMA_MODEL`
- `PLANABRAIN_OLLAMA_THINKING_MODE`
- `PLANABRAIN_OLLAMA_EMBEDDING_MODEL`
- `PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH`
- `PLANABRAIN_OLLAMA_ENABLE_WEB_FETCH`
- `PLANABRAIN_OLLAMA_WEB_SEARCH_MAX_RESULTS`
- `PLANABRAIN_OLLAMA_TOOL_MAX_ITERATIONS`

### 장기 메모리

- `PLANABOT_LOCAL_MEMORY_ENABLED`
- `PLANABRAIN_LOCAL_GROUP_MEMORY_ENABLED`
- `PLANABRAIN_LOCAL_MEMORY_DIR`
- `PLANABRAIN_LOCAL_MEMORY_STORE`
- `PLANABRAIN_LOCAL_MEMORY_SQLITE_PATH`
- `PLANABRAIN_LOCAL_MEMORY_COMPACTION_ENABLED`
- `PLANABRAIN_LOCAL_MEMORY_COMPACTION_KEEP_RECENT_TURNS`
- `PLANABRAIN_LOCAL_MEMORY_COMPACTION_MIN_SOURCE_TURNS`
- `PLANABRAIN_LOCAL_MEMORY_CONVERSATION_TTL_DAYS`
- `PLANABRAIN_LOCAL_MEMORY_RETRIEVAL_LOGGING_ENABLED`
- `PLANABOT_LOCAL_MEMORY_TOKEN_BUDGET`

장기 메모리 관리 CLI:

```bash
cd planabrain
node dist/cli/index.js memory-list-facts <userId> <chatId>
node dist/cli/index.js memory-update-fact <userId> <chatId> <factId> <value>
node dist/cli/index.js memory-delete-fact <userId> <chatId> <factId>
node dist/cli/index.js memory-reset-user <userId>
node dist/cli/index.js memory-reset-all
```

### 토큰 측정

- `PLANABOT_TOKEN_MODEL`
- `PLANABOT_TOKEN_LIMIT`
- `PLANABOT_TOKEN_ESTIMATE_MULTIPLIER`

## 로컬 데이터 경로

- `/.planabot`
- `/.planabrain`
- `planabrain/.planabrain`

이 경로들은 `.gitignore`에 포함되어 있습니다.

## Docker

### 개발용

```bash
docker compose up --build -d
```

메모리 전체 초기화:

```bash
docker compose exec planabot reset-local-memory
```

### 운영용

운영 서버는 GHCR 이미지를 직접 사용합니다.

```yaml
image: ghcr.io/yldst-dev/planabot:${PLANABOT_IMAGE_TAG:-latest}
```

기본 서비스:

- `planabot`
- `cloudflared`

운영 컨테이너에서 메모리 전체 초기화:

```bash
docker exec planabot reset-local-memory
```

## 운영 배포

### 서버 초기 설정

```bash
mkdir -p /path/to/planabot && cd /path/to/planabot
curl -O https://raw.githubusercontent.com/yldst-dev/planabot/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/yldst-dev/planabot/main/deploy.sh
chmod +x deploy.sh
mkdir -p .planabot
```

`.env`를 준비한 뒤 아래 명령으로 배포합니다.

```bash
./deploy.sh
```

### 이미지 태그 지정 배포

```bash
PLANABOT_IMAGE_TAG=0.1.14 ./deploy.sh
```

또는 `.env`에 아래 값을 넣어도 됩니다.

```dotenv
PLANABOT_IMAGE_TAG=0.1.14
```

### ARM64 주의사항

- `latest`는 단일 아키텍처일 수 있습니다.
- `deploy.sh`는 ARM64에서 `latest`를 못 받으면 최신 GitHub Release 태그를 조회한 뒤 해당 버전 이미지로 폴백합니다.
- 멀티아키 운영을 원하면 릴리즈 버전 이미지를 함께 올려야 합니다.

## GitHub Actions

기본 자동화 흐름은 아래와 같습니다.

- PR: 테스트만 실행
- `main` push: 테스트 후 `latest` 이미지 빌드
- `v*` 태그 push: 테스트 후 멀티아키 이미지 빌드 + GitHub Release 생성

이미지 위치:

- `ghcr.io/yldst-dev/planabot:latest`
- `ghcr.io/yldst-dev/planabot:0.1.14`

## 로컬 수동 릴리즈

GitHub Actions를 기다리지 않고 로컬에서 멀티아키 이미지를 직접 GHCR에 푸시할 수 있습니다.

1. 버전을 올립니다.
2. 커밋과 태그를 만듭니다.
3. 멀티아키 이미지를 푸시합니다.
4. GitHub Release를 생성합니다.

추가한 스크립트:

```bash
./scripts/release-ghcr.sh 0.1.14
```

동작:

- `gh auth token` 또는 `GHCR_TOKEN`, `GITHUB_TOKEN`으로 GHCR 로그인
- `linux/amd64,linux/arm64` 멀티아키 빌드
- `ghcr.io/yldst-dev/planabot:0.1.14` 푸시
- 기본값으로 `latest`도 함께 갱신

`latest` 갱신 없이 버전 태그만 올리려면:

```bash
PUSH_LATEST=0 ./scripts/release-ghcr.sh 0.1.14
```

릴리즈 생성 예시:

```bash
gh release create v0.1.14 --title "v0.1.14" --notes-file RELEASE_NOTES.md
```

## 체크리스트

릴리즈 전 권장 검증:

```bash
cargo fmt --check
cargo clippy -- -D warnings
cargo test
cd planabrain && npm run typecheck && npm run build
```

## 현재 릴리즈 기준 변경 포인트

- 그룹 대화 답장 체인 맥락 유지
- 이미지 분석을 planabrain 멀티모달 경로로 통합
- Google 의존성 없이 Ollama 임베딩 지원
- OpenRouter 웹 검색 tool 지원
- Vertex Express provider 지원
- Ollama 다중 API 키 fallback 지원
- 30초 응답 지연 감지
- 내부 메타 응답 누출 필터링
- 응답 잘림 자동 이어쓰기
- `/schedule`, `/timer` 기반 일정/타이머 예약
- Instagram 임베드 변환 도메인 `vxinstagram` 적용
- Threads 포스트 링크 추적 파라미터 정리
- `/version` 명령으로 현재 실행 버전 확인
