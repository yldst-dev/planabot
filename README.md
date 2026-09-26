# planabot

텔레그램에서 Hitomi 갤러리 조회, 링크 정리, 프라나 AI 응답을 함께 처리하는 봇입니다.

- Rust 봇 본체: `core/`
- TypeScript 기반 planabrain CLI: `planabrain/`
- 운영 배포: Dokploy 빌드-온-푸시 (`docker-compose.dokploy.yml`)

## 주요 기능

- Hitomi 갤러리 조회
- 갤러리 뷰어 HTML을 send.vis.ee로 올려 개인 채팅으로 전달
- YouTube, Spotify, Apple Music 추적 파라미터 정리
- Spotify, YouTube Music, Apple Music 링크는 표지·제목·아티스트 카드 이미지와 함께 전달
- X/Twitter → `fxtwitter`, Instagram 릴/게시물 → 채팅 미리보기 전송
- Threads 포스트 링크 추적 파라미터 정리
- 구글 공유 링크(share.google)를 실제 주소로 변환
- 일정/타이머 등록과 예약 메시지 전송
- `프라나야` 호출 기반 AI 응답
- 그룹 채팅 답장 체인 기준 맥락 유지
- 이미지 입력 분석
- 웹 검색 기반 최신 정보 응답
- 메시지에 포함된 웹 링크의 안전한 본문 직접 수집
- 장기 메모리와 그룹 공용 메모리
- 응답 잘림 감지 후 자동 이어쓰기
- codex 게이트웨이 하나로 모델 호출, OpenRouter는 판단 모델(Jev)에만 사용

## 저장소 구조

```text
core/                       Rust 텔레그램 봇
hiromi/                     갤러리 다운로드와 뷰어 HTML 공유 CLI
send-vis-ee-api/            send.vis.ee 업로드 라이브러리
planabrain/                 TypeScript CLI, 메모리, 검색, provider 연동
scripts/                    로컬 빌드 보조 스크립트
docker-compose.yml          로컬 개발용 compose
docker-compose.dokploy.yml  Dokploy 빌드-온-푸시용 compose
```

## 빠른 시작

1. `.env.example`을 복사해 `.env`를 만듭니다.

```bash
cp .env.example .env
```

2. 최소 필수값을 채웁니다.

```dotenv
TELEGRAM_API_TOKEN=123456:ABC-YourRealToken
CODEX_GATEWAY_API_KEY=cg_YOUR_KEY_HERE
PLANABRAIN_CODEX_BASE_URL=http://192.168.0.9:8080/v1
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
  - `받기`로 단일 뷰어 HTML을 준비한 뒤, `다운로드`는 개인 채팅으로 보냅니다.
- 명령어
  - `/start`
  - `/ping`
  - `/version`
  - `/token`
  - `/memory`
  - `/forget`
  - `/memoryreset`
  - `/schedule`
  - `/timer`
  - `/groupinfo` (그룹 전용)
  - `/chat_id` (개인 채팅 전용, 개인 채팅 명령 목록에만 표시)
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
- 최신 정보가 필요하면 Ollama 웹 검색 결과를 답변 전에 미리 넣고, 확인한 출처만 붙입니다.
- 질문에 웹 링크가 포함되면 planabrain이 공개 HTTP/HTTPS 페이지의 본문을 직접 추출해 참고합니다.
- 내부 네트워크 주소, 비표준 포트, 과도한 응답, 바이너리 콘텐츠와 위험한 리디렉션은 차단합니다.
- 응답이 길이 제한으로 끊기면 자동으로 이어서 받아 한 번 더 합칩니다.
- 최종 텔레그램 전송 전에는 1024토큰 기준으로 한 번 더 정리해 문장 중간 출처 삽입과 과도한 장문 응답을 줄입니다.
- 내부 메타 문장이나 reasoning 누출은 후처리에서 제거합니다.
- 선생님이 먼저 연 친밀 장면은 같은 수위로 이어가고, 모델이 거절하면 한 번 더 시도합니다.

## 모델 연결

### Codex gateway (주 모델과 보조 모델)

- 필수: `CODEX_GATEWAY_API_KEY`, `PLANABRAIN_CODEX_BASE_URL` (또는 `CODEX_GATEWAY_BASE_URL`)
- 기본 모델: `gpt-6-astra` (`PLANABRAIN_CODEX_MODEL`로 변경)
- 자체 호스팅 codex-gateway의 Responses API(`POST /responses`)를 스트리밍으로 호출합니다. 게이트웨이 규칙에 맞춰 `store: false`, `stream: true`, 배열 `input`을 보내고 `max_output_tokens`, `temperature`는 보내지 않습니다.
- 시스템 프롬프트는 `instructions`로 보냅니다. 비어 있으면 게이트웨이가 코딩 에이전트용 지시문을 넣으므로 항상 채웁니다.
- 생각 모드 `off`와 `minimal`은 `reasoning.effort: low`로 보냅니다. `default`면 모델 기본값을 씁니다.
- `PLANABRAIN_CODEX_FAST=1`이면 답변 호출에 `service_tier: "priority"`를 붙여 fast 모드로 보냅니다. Codex 사용량을 표준의 2.5배 쓰므로 검색어 재작성, 전달문 재작성, 기억 작성 같은 보조 호출에는 붙이지 않습니다.
- 이미지 입력은 `input_image` data URL로 보냅니다.
- `PLANABRAIN_AI_PROVIDER`, `PLANABRAIN_AUX_PROVIDER`는 비우거나 `codex`로 둡니다. 다른 값이면 시작할 때 오류가 납니다.
- 권장 타임아웃: `PLANABRAIN_HTTP_TIMEOUT_MS=180000`

### 웹 검색 (Ollama)

- codex에는 검색 도구가 없어서, 시의성 질문이면 Ollama 웹 검색 결과를 답변 전에 미리 넣습니다.
- 필수: `PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH=1`, `OLLAMA_API_KEY` 또는 `OLLAMA_API_KEYS`
- 키가 없으면 시의성 질문에 "확인 불가" 응답이 나옵니다. 검색 결과와 출처를 확인하지 못한 답변은 폐기하는 설계이기 때문입니다.

### 판단 모델 (OpenRouter Jev)

- 턴 판단(할 일과 일정 경로, 최신 정보 필요 여부, 후속 질문, 인사, 기억 관련성)과 기억 저장 판단을 한 번의 호출로 처리합니다.
- `PLANABRAIN_DECISION_PROVIDER=jev`와 `OPENROUTER_API_KEY`(또는 `PLANABRAIN_DECISION_API_KEY`)로 켭니다. 꺼져 있으면 규칙 판단을 씁니다.
- OpenRouter는 이 판단 모델에만 씁니다.

```bash
CODEX_GATEWAY_API_KEY=cg_YOUR_KEY_HERE
PLANABRAIN_CODEX_BASE_URL=http://192.168.0.9:8080/v1
PLANABRAIN_CODEX_MODEL=gpt-6-astra
PLANABRAIN_HTTP_TIMEOUT_MS=180000
PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH=1
OLLAMA_API_KEY=YOUR_OLLAMA_API_KEY_HERE
PLANABRAIN_DECISION_PROVIDER=jev
OPENROUTER_API_KEY=YOUR_OPENROUTER_API_KEY_HERE
```

## 주요 환경변수

### 공통

- `TELEGRAM_API_TOKEN`
- `PLANABRAIN_ENABLED`
- `PLANABRAIN_AI_PROVIDER` (비우거나 `codex`)
- `CODEX_GATEWAY_API_KEY`, `PLANABRAIN_CODEX_BASE_URL`, `PLANABRAIN_CODEX_MODEL`
- `PLANABRAIN_DELIVERY_MAX_OUTPUT_TOKENS`
- `PLANABRAIN_DELIVERY_REWRITE_ENABLED`
- `PLANABRAIN_CHAT_THINKING_MODE`
- `PLANABRAIN_SYSTEM_PROMPT`
- `PLANABRAIN_PERSONA_PROFILE` (`live` 기본, `original`은 동결 백업)
- `PLANABRAIN_INTIMACY_ENABLED`
- `PLANABRAIN_INTIMACY_FALLBACK_MODEL`
- `PLANABRAIN_CONTINUOUS_CHAT` (기본 0, 1이면 지난 대화를 정리된 형태로 매번 다시 보냄)
- `PLANABRAIN_SEARCH_QUERY_REWRITE` (기본 1, 시의성 질문의 검색어를 모델이 다시 작성)
- `PLANABRAIN_AUX_MODEL` (검색어 재작성, 전달문 재작성, 기억 작성 같은 보조 호출에 쓸 codex 모델, 비우면 주 모델 사용)
- `PLANABRAIN_DATA_DIR` (planabrain 데이터 루트, 기본값은 저장소 루트이며 `.planabrain/*` 상대 경로의 기준)
- `PLANABOT_PLANABRAIN_SERVER` (기본 1, planabrain 상주 서버 사용 여부)
- `PLANABRAIN_SERVER_PORT` (기본 0, 상주 서버가 쓸 루프백 포트이며 0이면 자동 선택)
- `PLANABRAIN_HTTP_TIMEOUT_MS` (전역 HTTP 타임아웃, 기본 60000. codex는 180000 권장)
- `PLANABRAIN_WEB_FETCH_ENABLED`
- `PLANABRAIN_WEB_FETCH_TIMEOUT_MS`
- `PLANABRAIN_WEB_FETCH_MAX_BYTES`
- `PLANABRAIN_WEB_FETCH_MAX_CHARS`
- `PLANABRAIN_WEB_FETCH_MAX_TOTAL_CHARS`
- `PLANABRAIN_ALLOWED_CHAT_IDS` (그룹은 이 목록에 있는 채팅에서만 응답)
- `PLANABRAIN_ALLOWED_USER_IDS` (개인 채팅 허용 사용자. 비우면 모든 개인 채팅 허용)

### 웹 검색과 판단 모델

- `PLANABRAIN_OLLAMA_ENABLE_WEB_SEARCH`, `OLLAMA_API_KEY`, `OLLAMA_API_KEYS`, `PLANABRAIN_OLLAMA_SEARCH_HOST`, `PLANABRAIN_OLLAMA_WEB_SEARCH_MAX_RESULTS`
- `PLANABRAIN_DECISION_PROVIDER`, `OPENROUTER_API_KEY`, `PLANABRAIN_DECISION_API_KEY`, `PLANABRAIN_DECISION_BASE_URL`, `PLANABRAIN_DECISION_MODEL`, `PLANABRAIN_DECISION_TIMEOUT_MS`

### 장기 메모리

- 대화 기록과 장기 기억은 `PLANABRAIN_MEMORY_DB_PATH`(기본 `.planabrain/memory.sqlite`) 한 파일에 저장합니다.
- 답변을 보낸 뒤 판단 모델이 기억할 내용이 있는지 먼저 확인하고, 있으면 보조 모델이 기억을 추가, 수정, 삭제합니다. 이 작업은 백그라운드에서 돌아서 다음 대화를 막지 않습니다.
- 다음 질문을 받으면 호칭과 부탁한 규칙은 항상 넣고, 나머지 기억은 턴 판단 호출에서 관련 있다고 판단된 것만 넣습니다. 판단 모델이 꺼져 있으면 낱말 겹침으로 고릅니다.
- DM에서 알게 된 기억은 DM에서만 씁니다. 그룹에서 알게 된 기억은 그 그룹과 본인 DM에서 씁니다.
- `/memory`로 이 대화방에서 쓰는 기억을 번호와 함께 보고, `/forget 번호`로 하나씩 지웁니다.

설정:

- `PLANABOT_LOCAL_MEMORY_ENABLED`
- `PLANABOT_LOCAL_MEMORY_TOKEN_BUDGET`
- `PLANABRAIN_MEMORY_DB_PATH`
- `PLANABRAIN_MEMORY_MAX_TURNS`
- `PLANABRAIN_MEMORY_CONVERSATION_TTL_DAYS`
- `PLANABRAIN_MEMORY_MAX_ITEMS`
- `PLANABRAIN_MEMORY_WRITER_ENABLED`

관리 CLI:

```bash
cd planabrain
node dist/cli/index.js memory-list <userId> <chatScope>
node dist/cli/index.js memory-forget <userId> <chatScope> <memoryId>
node dist/cli/index.js memory-reset-user <userId>
node dist/cli/index.js memory-reset-all
```

### 토큰 측정

- `PLANABOT_TOKEN_MODEL`
- `PLANABOT_TOKEN_LIMIT`
- `PLANABOT_TOKEN_ESTIMATE_MULTIPLIER`

## 설정 대시보드

헬스체크 포트(`HEALTH_PORT`, 기본 8080)의 `/` 경로에서 설정 대시보드가 열립니다. `PLANABOT_DASHBOARD_ENABLED=0`이면 꺼집니다.

화면은 `dashboard/`의 React(TypeScript), shadcn/ui, Tailwind CSS 앱이고, 봇은 빌드 결과(`PLANABOT_DASHBOARD_DIR`, 기본 `dashboard/dist`)를 그대로 서빙합니다. Docker 이미지는 빌드 단계에서 함께 만듭니다.

```bash
cd dashboard
npm ci
npm run build      # dashboard/dist 생성, 봇을 띄우면 / 에서 열림
npm run dev        # 화면 개발용, /api 요청은 127.0.0.1:8080 으로 넘김
```

### 비밀번호

1. 비밀번호가 없으면 봇이 시작할 때 로그에 설정 코드를 남깁니다. `docker logs planabot 2>&1 | grep "설정 코드"`로 찾습니다.
2. 첫 접속 화면에서 설정 코드와 새 비밀번호(8자 이상)를 입력합니다. 설정 코드는 URL을 먼저 연 다른 사람이 비밀번호를 가로채지 못하게 막는 용도입니다.
3. 설정을 마치면 복구 코드가 한 번만 표시됩니다. 비밀번호 관리자 같은 곳에 보관하십시오.

비밀번호를 잊었을 때는 두 가지 방법이 있습니다.

- 로그인 화면의 "비밀번호를 잊으셨습니까?"에서 복구 코드와 새 비밀번호를 입력합니다. 복구 코드는 한 번 쓰면 새 코드로 바뀝니다.
- 복구 코드도 없으면 서버에서 아래 명령을 실행합니다. 비밀번호와 모든 로그인 세션이 지워지고 새 설정 코드가 출력되므로, 그 코드로 처음처럼 다시 설정합니다. 로컬에서는 `cargo run -- dashboard-reset-password`입니다.

```bash
docker exec planabot planabot dashboard-reset-password
```

로그인한 뒤에는 사이드바 아래 계정 메뉴에서 비밀번호 변경과 복구 코드 재발급을 할 수 있습니다. 비밀번호를 바꾸면 다른 기기의 로그인은 모두 끊깁니다.

비밀번호, 복구 코드, 설정 코드는 PBKDF2-SHA256(비밀번호는 600,000회)으로 해시해 `.planabot/dashboard-auth.json`(권한 600)에만 남깁니다. 로그인, 설정, 복구를 합쳐 5번 연속 실패하면 10분 동안 막습니다. 로그인 세션은 12시간 유지되고 재시작해도 살아 있습니다.

### 설정 값

- 왼쪽 사이드바에서 봇, planabrain, 제공자(Codex 게이트웨이, 웹 검색, 판단 모델), 시스템 분류를 오가며 값을 바꿉니다. `⌘K` 또는 `/`로 설정 검색, `⌘S`/`Ctrl+S`로 저장합니다.
- 저장한 값은 `PLANABOT_DASHBOARD_STATE_PATH`(기본 `.planabot/dashboard.json`, 권한 600)에 남고, 프로세스가 시작할 때 `.env`와 컨테이너 env보다 먼저 적용됩니다. 되돌리기 버튼을 누르면 대시보드 값을 지우고 env 값으로 돌아갑니다.
- 실행 중인 프로세스에는 바로 반영되지 않습니다. 사이드바의 재시작 버튼을 누르면 프로세스가 종료되고, 컨테이너 재시작 정책(`restart: unless-stopped`)으로 다시 올라오면서 적용됩니다. 로컬 `cargo run`에서는 직접 다시 실행해야 합니다.
- API 키와 토큰은 화면과 API 응답에 끝 4자리만 보이며 원문은 돌려주지 않습니다.
- 목록에 없는 키는 사용자 지정 메뉴에서 추가합니다. `PLANABOT_`, `PLANABRAIN_`, `CODEX_`, `OLLAMA_`, `OPENROUTER_`, `SENDVIS_` 접두사만 허용하며, 대시보드 자체 설정(`PLANABOT_DASHBOARD_*`)은 대시보드에서 바꿀 수 없습니다.
- 공개 도메인에 연결할 때는 반드시 HTTPS 리버스 프록시 뒤에 두십시오. `X-Forwarded-Proto: https`가 오면 쿠키에 `Secure`를 붙입니다.

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

## 운영 배포 (Dokploy)

운영 서버는 Dokploy에서 소스를 직접 빌드하는 빌드-온-푸시 방식을 사용합니다.

### Dokploy 설정

- 서비스 타입: Docker Compose
- Repository: `planabot`, Branch: `main`
- Compose Path: `./docker-compose.dokploy.yml`
- Trigger Type: On Push
- Environment: `.env`의 모든 키를 입력 (Dokploy가 `.env`로 주입)

`docker-compose.dokploy.yml`은 명명 볼륨으로 상태와 메모리를 영속화합니다.

- `planabot-state` → `/app/.planabot`
- `planabrain-data` → `/app/.planabrain` (로컬 메모리 sqlite, 대화 메모리)

`main`에 push하면 Dokploy가 Dockerfile로 빌드 후 재배포합니다. Rust 빌드는 메모리를 많이 사용하므로 호스트 RAM 2GB 이상을 권장합니다.

운영 컨테이너에서 메모리 전체 초기화:

```bash
docker exec planabot reset-local-memory
```

## 릴리즈

1. 버전을 올립니다 (`Cargo.toml`, `Cargo.lock`).
2. 커밋 후 `main`에 push합니다.
3. Dokploy가 자동으로 빌드·배포합니다.

`v*` 태그를 push하면 GitHub Actions가 변경 로그 기반 GitHub Release를 생성합니다.

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
- codex 게이트웨이 단일 모델 연결과 Ollama 사전 검색
- OpenRouter Jev 판단 모델로 턴 판단과 기억 관련성 판단
- Ollama 다중 API 키 fallback 지원
- 30초 응답 지연 감지
- 내부 메타 응답 누출 필터링
- 응답 잘림 자동 이어쓰기
- `/schedule`, `/timer` 기반 일정/타이머 예약
- Instagram 릴/게시물을 텔레그램 동영상·사진 미리보기로 전송
- Threads 포스트 링크 추적 파라미터 정리
- 구글 공유 링크(share.google)를 실제 주소로 변환
- `/version` 명령으로 현재 실행 버전 확인
