# planabot

Hitomi.la 갤러리 정보 조회 + URL 정리(YouTube/Spotify si 제거, X→fxtwitter, Instagram→kkinstagram 변환)를 한 번에 처리하는 텔레그램 봇입니다. 기존 Node.js 버전을 Rust로 재작성하고, URL 체인저 기능을 통합했습니다. 추가로 planabrain(TypeScript CLI)을 통해 베타 AI 응답 기능을 제공합니다.

## 빠른 시작
1) Rust stable 설치 후 프로젝트 루트에서 `.env` 생성/수정:
```
TELEGRAM_API_TOKEN=123456:ABC-YourRealToken
GOOGLE_API_KEY=YOUR_API_KEY_HERE
PLANABRAIN_AI_PROVIDER=google
PLANABRAIN_CHAT_MODEL=gemini-3-flash-preview
PLANABRAIN_ENABLED=1
# 베타 AI 기능을 허용할 채팅 ID (쉼표/공백/세미콜론 구분 가능)
PLANABRAIN_ALLOWED_CHAT_IDS=-1001234567890,-1009876543210
# 베타 AI 기능을 허용할 사용자 ID (1:1 대화용)
PLANABRAIN_ALLOWED_USER_IDS=123456789,987654321
```
`PLANABRAIN_AI_PROVIDER=geminimock` 사용 시에는 `GOOGLE_API_KEY` 없이도 동작하며, `PLANABRAIN_GEMINIMOCK_BASE_URL` 또는 `GEMINI_CLI_API_HOST`/`GEMINI_CLI_API_PORT`를 설정하면 됩니다.
`PLANABRAIN_AI_PROVIDER=openrouter` 사용 시에는 `OPENROUTER_API_KEY`와 `PLANABRAIN_OPENROUTER_MODEL`을 설정하면 됩니다.
토큰이 없으면 실행 시 `.env`가 자동 생성되고 경고 후 종료합니다.

2) 실행
```bash
cd planabot
cargo run --release
```

## 사용 방법
- Hitomi 조회: `!<ID>` (모든 채팅), `<ID>` (개인 채팅), `@봇계정 <ID>` (그룹)
- 명령어: `/start`, `/ping`, `/token`, `/memoryreset`, `/groupinfo`
- URL 정리: 메시지에 포함된
  - YouTube/YouTube Music/Spotify/Apple Music 링크 → 추적 파라미터 제거
  - X/Twitter 링크 → `fxtwitter.com`으로 변환
  - Instagram 링크 → `kkinstagram.com`으로 변환
  관리자인 경우 원본 메시지를 삭제하고 정리된 링크로 재전송, 아니면 인라인 버튼/텍스트로 대체 링크 제공
- 음악 링크가 포함된 메시지에서는 정리된 링크를 제공하고, 같은 곡의
  스포티파이/유튜브 뮤직/유튜브/애플 뮤직 링크를 인라인 버튼으로 제공합니다
  (원본 플랫폼 버튼은 제외). 매핑 실패 시 정리된 링크만 전송합니다.
- 유튜브 모바일 링크(`m.youtube.com`)도 처리합니다.
- 추적 파라미터가 없는 링크에는 “제거” 안내를 출력하지 않습니다.
- 봇이 재시작된 이후의 메시지만 처리합니다. (`/ping`은 예외)
- 봇은 KST 자정(00:00)에만 재시동되며 재시동 기록은 터미널 로그에만 남습니다.
- 텔레그램 통신 불능 오류나 치명적 패닉이 발생하면 즉시 재시동합니다.
- 베타 AI 호출: `프라나야`로 시작하는 메시지
  - `PLANABRAIN_ENABLED=0`이면 AI 기능(`/token`, `/memoryreset` 포함)이 비활성화됩니다.
  - `PLANABRAIN_AI_PROVIDER=google|geminimock|openrouter`로 모델 통신 경로를 선택합니다.
  - 개인채팅에서는 `sendMessageDraft`가 가능하면 상태 메시지를 먼저 표시하고, 불가하면 기존 `typing`으로 폴백합니다.
  - `geminimock` 모드에서는 OpenAI 호환 `/v1/chat/completions`를 사용합니다.
  - `geminimock` 모드 주소는 `PLANABRAIN_GEMINIMOCK_BASE_URL` 또는 `GEMINI_CLI_API_HOST`/`GEMINI_CLI_API_PORT`에서 읽습니다.
  - `openrouter` 모드에서는 OpenAI 호환 `/chat/completions`를 사용하며 `Authorization: Bearer <OPENROUTER_API_KEY>` 헤더로 호출합니다.
  - OpenRouter 권장 헤더 `HTTP-Referer`, `X-Title`도 각각 `PLANABRAIN_OPENROUTER_SITE_URL`, `PLANABRAIN_OPENROUTER_APP_NAME`으로 설정할 수 있습니다.
  - 임베딩 기반 명령(예: `ingest`)과 Google Search 내장 툴은 `google` 모드에서만 지원합니다.
  - `PLANABRAIN_ALLOWED_CHAT_IDS`에 포함된 채팅 또는 `PLANABRAIN_ALLOWED_USER_IDS`에 포함된 1:1 사용자만 동작
  - 텍스트/미디어 캡션 모두 인식하며, 다른 사용자 메시지에 대한 답장은 컨텍스트로 포함합니다.
  - 현재 시각은 인터넷 KST(실패 시 로컬 KST) 기준으로 질문에 포함합니다.
  - 프라나 말투로 응답합니다.
  - 캡션 포함 이미지 또는 답장 이미지가 있으면 임시 저장 후 분석해 컨텍스트에 포함합니다.
  - planabrain 내장 장기 메모리 컨텍스트를 함께 주입합니다. (`PLANABOT_LOCAL_MEMORY_ENABLED=1`)
  - 장기 메모리는 사용자별 스코프 + 그룹 공용 스코프를 함께 사용합니다.
  - 오래된 대화는 rolling summary로 자동 압축하고, 최근 몇 턴만 원문으로 유지합니다.
  - `/memoryreset`은 기존 planabrain 메모리와 장기 메모리를 함께 정리합니다.
- 토큰 측정: 측정할 메시지에 답장한 뒤 `/token`
  - 텍스트/캡션 메시지를 `tokenx` 기반으로 로컬 추정합니다. (외부 토큰 API 미사용)
  - 모델명(`PLANABOT_TOKEN_MODEL`)에 따라 프로파일을 선택해 추정합니다.
  - 기본 기준값 1024 토큰 초과 여부를 함께 안내합니다.

## planabrain (TypeScript CLI)
- 위치: `planabrain/`
- 개발 실행: `npm run dev`
- 타입 체크: `npm run typecheck`
- 빌드: `npm run build`
- JSON 메모리 마이그레이션: `node dist/cli/index.js memory-migrate-json [sourceDir]`

## 장기 메모리 검증 체크리스트
1. 사전 확인
   - `.env`에 `PLANABOT_LOCAL_MEMORY_ENABLED=1` 설정
   - 봇 재시작 후 `프라나야` 호출 가능한 채팅에서 테스트
2. 선호 기억 확인
   - 사용자 입력: `프라나야 나는 말차 라떼를 좋아해`
   - 다음 입력: `프라나야 내가 좋아하는 음료 뭐였지`
   - 기대 결과: 말차 라떼 선호를 재호출
3. 시간 간격 후 재호출 확인
   - 몇 분 뒤 같은 질문 재시도
   - 기대 결과: 동일 선호 정보 유지
4. 채팅 스코프 분리 확인
   - 다른 그룹/개인채팅에서 같은 사용자로 `프라나야 내가 좋아하는 음료 뭐였지` 질문
   - 기대 결과: 원래 채팅의 선호가 자동 전이되지 않음
5. 그룹 공용 메모리 확인
   - 같은 그룹에서 사용자 A가 `우리 방 규칙은 1024 토큰 초과 금지야` 입력
   - 같은 그룹에서 사용자 B가 `프라나야 우리 방 규칙이 뭐야` 질문
   - 기대 결과: 규칙이 재호출됨
6. 메모리 초기화 확인
   - 같은 사용자로 `/memoryreset`
   - 다음 입력: `프라나야 내가 좋아하는 음료 뭐였지`
   - 기대 결과: 기존 선호 기억이 사라짐
7. 비활성화 확인
   - `.env`에서 `PLANABOT_LOCAL_MEMORY_ENABLED=0` 설정 후 재시작
   - 같은 시나리오 반복
   - 기대 결과: 장기 기억 주입 없이 기본 동작
8. 로컬 저장 확인
   - `.planabrain/local-memory/memory.sqlite` 파일 생성 여부 확인
   - 기대 결과: 실행 중 SQLite 파일이 생성되고 갱신됨

## 환경변수
- `TELEGRAM_API_TOKEN`: 텔레그램 봇 토큰
- `GOOGLE_API_KEY` (또는 `GEMINI_API_KEY`): Gemini API 키 (`PLANABRAIN_AI_PROVIDER=google`일 때 필수)
- `OPENROUTER_API_KEY`: OpenRouter API 키 (`PLANABRAIN_AI_PROVIDER=openrouter`일 때 필수)
- `PLANABRAIN_AI_PROVIDER` (기본 `google`): `google`, `geminimock`, `openrouter`
- `PLANABOT_TELEGRAM_DRAFT_ENABLED` (기본 `1`): 개인채팅에서 Telegram `sendMessageDraft` 상태 표시 사용 여부 (`0`/`false`면 비활성화)
- `PLANABRAIN_OPENROUTER_MODEL` (기본 `openai/gpt-4o-mini`): OpenRouter 전용 모델명. 예: `google/gemini-3-flash-preview`
- `PLANABRAIN_CHAT_MODEL` (기본 `google`: `gemini-3-flash-preview`, `geminimock`: `gemini-2.5-pro`)
- `PLANABRAIN_GEMINI_MODEL`: 구버전 호환용 모델 환경변수. `PLANABRAIN_CHAT_MODEL`이 우선합니다.
- `PLANABRAIN_GEMINIMOCK_BASE_URL` (기본 비어 있음): GeminiMock API 기본 URL (예: `http://127.0.0.1:43173`)
- `GEMINI_CLI_API_HOST` (기본 `127.0.0.1`): `PLANABRAIN_GEMINIMOCK_BASE_URL` 미설정 시 GeminiMock 호스트
- `GEMINI_CLI_API_PORT` (기본 `43173`): `PLANABRAIN_GEMINIMOCK_BASE_URL` 미설정 시 GeminiMock 포트
- `GEMINI_CLI_MODEL` (기본 `gemini-2.5-pro`): `geminimock` 모드에서 `PLANABRAIN_CHAT_MODEL`/`PLANABRAIN_GEMINI_MODEL` 미설정 시 사용
  - `PLANABRAIN_GEMINIMOCK_BASE_URL`이 비어 있으면 `geminimock server status`에서 URL 자동 감지 후, 실패 시 `http://127.0.0.1:43173`(및 `localhost`)로 폴백
- `PLANABRAIN_OPENROUTER_BASE_URL` (기본 `https://openrouter.ai/api/v1`): OpenRouter API 기본 URL
- `PLANABRAIN_OPENROUTER_SITE_URL` (기본 비어 있음): OpenRouter `HTTP-Referer` 헤더 값
- `PLANABRAIN_OPENROUTER_APP_NAME` (기본 비어 있음): OpenRouter `X-Title` 헤더 값
- `PLANABRAIN_ENABLED` (기본 `1`): planabrain 기능 전체 사용 여부 (`0`/`false`/`off`/`no`/빈 값이면 비활성화)
- `PLANABRAIN_ALLOWED_CHAT_IDS`: 베타 AI 허용 채팅 ID 목록
- `PLANABRAIN_ALLOWED_USER_IDS`: 베타 AI 허용 사용자 ID 목록 (1:1 대화)
- `PLANABOT_LOCAL_MEMORY_ENABLED` (기본 `1`): 장기 메모리 사용 여부 (`0`/`false`면 비활성화)
- `PLANABOT_LOCAL_MEMORY_TOKEN_BUDGET` (기본 `900`): 장기 메모리 컨텍스트 패킹 시 토큰 예산
- `PLANABRAIN_LOCAL_MEMORY_DIR` (기본 `.planabrain/local-memory`): 장기 메모리 저장 경로
- `PLANABRAIN_LOCAL_MEMORY_STORE` (기본 `sqlite`): 장기 메모리 저장소 (`sqlite` 또는 `json`)
- `PLANABRAIN_LOCAL_MEMORY_SQLITE_PATH` (기본 `.planabrain/local-memory/memory.sqlite`): SQLite 파일 경로
- `PLANABRAIN_LOCAL_GROUP_MEMORY_ENABLED` (기본 `1`): 그룹 공용 메모리 사용 여부
- `PLANABRAIN_LOCAL_MEMORY_COMPACTION_ENABLED` (기본 `1`): 오래된 대화를 rolling summary로 자동 압축할지 여부
- `PLANABRAIN_LOCAL_MEMORY_COMPACTION_KEEP_RECENT_TURNS` (기본 `6`): compaction 이후 원문으로 남겨둘 최근 turn 수
- `PLANABRAIN_LOCAL_MEMORY_COMPACTION_MIN_SOURCE_TURNS` (기본 `8`): 이 수 이상 누적된 오래된 turn이 생기면 compaction 실행
- `PLANABOT_TOKEN_MODEL` (기본 비어 있음): `/token` 추정 모델명. 비어 있으면 `PLANABRAIN_OPENROUTER_MODEL`, `PLANABRAIN_CHAT_MODEL`, `PLANABRAIN_GEMINI_MODEL` 순서로 사용
- `PLANABOT_TOKEN_LIMIT` (기본 `1024`): `/token` 기준 토큰 임계값
- `PLANABOT_TOKEN_ESTIMATE_MULTIPLIER` (기본 `1.0`): `/token` 추정값 보정 배수 (`1.1`이면 10% 보수적으로 계산)
- `PLANABRAIN_EMBEDDING_MODEL` (기본 `gemini-embedding-001`)
- `PLANABRAIN_GEMINI_EMBEDDING_MODEL`: 구버전 호환용 임베딩 모델 환경변수. `PLANABRAIN_EMBEDDING_MODEL`이 우선합니다.
- `PLANABRAIN_CHAT_MAX_OUTPUT_TOKENS` (기본 `1024`, `0`이면 제한 해제)
- `PLANABRAIN_GEMINI_MAX_OUTPUT_TOKENS`: 구버전 호환용 출력 토큰 환경변수. `PLANABRAIN_CHAT_MAX_OUTPUT_TOKENS`가 우선합니다.
- `PLANABRAIN_GEMINI_VISION_MAX_OUTPUT_TOKENS` (기본 `512`, `0`이면 제한 해제. 이미지 분석 전용)
- `PLANABRAIN_INDEX_PATH` (기본 `.planabrain/index.json`)
- `PLANABOT_GROUPS_PATH` (기본 `.planabot/groups.json`): 봇이 참여한 그룹 채팅 ID 저장 경로
- `PLANABOT_PLANABRAIN_REPLIES_PATH` (기본 `.planabot/planabrain_replies.json`): planabrain 답변 ID 저장 경로
- `PLANABOT_IMAGE_TAG` (기본 `latest`, 배포 스크립트 전용): `deploy.sh`가 사용할 Docker 이미지 태그
- `WEBSHARE_API_KEY`: Webshare 프록시 API 키 (song.link 매핑에 프록시 사용 시)
- `WEBSHARE_MODE` (기본 `direct`): `direct` 또는 `backbone`
- `WEBSHARE_COUNTRY_CODES`: 국가 코드 필터 (예: `US,KR`)
- `WEBSHARE_PLAN_ID`: 특정 플랜 ID 필터
- `WEBSHARE_PAGE_SIZE` (기본 `25`)
- `SONGLINK_DIRECT_FALLBACK` (기본 `false`): 프록시 전부 rate limit일 때 direct 요청 허용
- 프록시 헬스 체크는 5분 간격으로 수행하며 결과는 로그에 기록됩니다.

## 빌드 산출물
- 릴리즈 바이너리: `target/release/planabot`

## Linux 바이너리 호환성 (glibc 오류)
- 에러 예: `GLIBC_2.39 not found`
- 호스트 glibc에 맞는 바이너리를 만들려면:
  - `./scripts/build-release.sh`
- 출력: `dist/planabot`
- 강제 지정이 필요하면:
  - `PLANABOT_DEBIAN_RELEASE=bullseye ./scripts/build-release.sh`

## Docker 실행 (개발용, 로컬 빌드)
- 호스트 glibc 버전에 맞춰 이미지를 선택하려면:
  - `./scripts/compose-up.sh`
- 직접 지정하려면:
  - `PLANABOT_RUNTIME_IMAGE=debian:bookworm-slim PLANABOT_RUST_IMAGE=rustlang/rust:nightly-bookworm PLANABOT_NODE_IMAGE=node:22-bookworm-slim docker compose up --build -d`

## CI/CD

이 저장소는 GitHub Actions를 통해 자동으로 테스트와 배포를 수행합니다.

### 파이프라인

| 트리거 | 테스트 | Docker 빌드 & 푸시 |
|-------|-------|-------------------|
| Pull Request | ✅ | ❌ |
| main push | ✅ | ✅ (테스트 통과 시) |
| 태그 push (v*) | ✅ | ✅ (테스트 통과 시) |

### 테스트 항목

**Rust (core/):**
- `cargo fmt --check` - 코드 포맷팅
- `cargo clippy -- -D warnings` - 린트
- `cargo test` - 유닛 테스트

**TypeScript (planabrain/):**
- `npm run typecheck` - 타입 체크
- `npm run build` - 빌드

### Docker 이미지

빌드된 이미지는 GitHub Container Registry에 푸시됩니다:
- `ghcr.io/yldst-dev/planabot:latest` - main 브랜치 최신
- `ghcr.io/yldst-dev/planabot:1.2.3` - 태그 버전
- `main` push는 `linux/amd64` 단일 아키텍처로 빌드합니다.
- `v*` 태그 push는 `linux/amd64,linux/arm64` 멀티아키텍처로 빌드합니다.

## 배포 (Production Deployment)

### 서버 초기 설정 (1회)

```bash
mkdir -p /path/to/planabot && cd /path/to/planabot

# 필요한 파일 다운로드
curl -O https://raw.githubusercontent.com/yldst-dev/planabot/main/docker-compose.prod.yml
curl -O https://raw.githubusercontent.com/yldst-dev/planabot/main/deploy.sh
chmod +x deploy.sh

# .env 파일 생성
cat > .env << 'EOF'
TELEGRAM_API_TOKEN=your_token_here
GOOGLE_API_KEY=your_api_key_here
PLANABRAIN_AI_PROVIDER=google
PLANABRAIN_CHAT_MODEL=gemini-3-flash-preview
PLANABRAIN_ALLOWED_CHAT_IDS=-1001234567890
PLANABRAIN_ALLOWED_USER_IDS=123456789
EOF

# 데이터 디렉토리 생성
mkdir -p .planabot
```

### 배포

```bash
./deploy.sh
```

ARM64 서버에서 `latest`가 단일 아키텍처일 경우 `deploy.sh`는 GitHub 최신 릴리즈 태그(예: `1.2.3`)로 자동 폴백합니다. 릴리즈 태그가 없거나 ARM64 이미지가 없으면 배포를 중단하고 `v*` 태그 릴리즈를 안내합니다.

또는:

```bash
docker compose -f docker-compose.prod.yml pull
docker compose -f docker-compose.prod.yml up -d
```

### 롤백

`docker-compose.prod.yml`에서 이미지 태그 변경:

```yaml
image: ghcr.io/yldst-dev/planabot:v1.0.0
```

그 후 재배포:

```bash
./deploy.sh
```

## Todo
- (정리됨) 이미지 캡션/답장 기반 분석 지원
