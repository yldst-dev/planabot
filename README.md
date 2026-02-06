# planabot

Hitomi.la 갤러리 정보 조회 + URL 정리(YouTube/Spotify si 제거, X→fxtwitter, Instagram→kkinstagram 변환)를 한 번에 처리하는 텔레그램 봇입니다. 기존 Node.js 버전을 Rust로 재작성하고, URL 체인저 기능을 통합했습니다. 추가로 planabrain(TypeScript CLI)을 통해 베타 AI 응답 기능을 제공합니다.

## 빠른 시작
1) Rust stable 설치 후 프로젝트 루트에서 `.env` 생성/수정:
```
TELEGRAM_API_TOKEN=123456:ABC-YourRealToken
GOOGLE_API_KEY=YOUR_API_KEY_HERE
# 베타 AI 기능을 허용할 채팅 ID (쉼표/공백/세미콜론 구분 가능)
PLANABRAIN_ALLOWED_CHAT_IDS=-1001234567890,-1009876543210
# 베타 AI 기능을 허용할 사용자 ID (1:1 대화용)
PLANABRAIN_ALLOWED_USER_IDS=123456789,987654321
```
토큰이 없으면 실행 시 `.env`가 자동 생성되고 경고 후 종료합니다.

2) 실행
```bash
cd planabot
cargo run --release
```

## 사용 방법
- Hitomi 조회: `!<ID>` (모든 채팅), `<ID>` (개인 채팅), `@봇계정 <ID>` (그룹)
- 명령어: `/start`, `/ping`
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
  - `PLANABRAIN_ALLOWED_CHAT_IDS`에 포함된 채팅 또는 `PLANABRAIN_ALLOWED_USER_IDS`에 포함된 1:1 사용자만 동작
  - 텍스트/미디어 캡션 모두 인식하며, 다른 사용자 메시지에 대한 답장은 컨텍스트로 포함합니다.
  - 현재 시각은 인터넷 KST(실패 시 로컬 KST) 기준으로 질문에 포함합니다.
  - 프라나 말투로 응답합니다.
  - 캡션 포함 이미지 또는 답장 이미지가 있으면 임시 저장 후 분석해 컨텍스트에 포함합니다.

## planabrain (TypeScript CLI)
- 위치: `planabrain/`
- 개발 실행: `npm run dev`
- 타입 체크: `npm run typecheck`
- 빌드: `npm run build`

## 환경변수
- `TELEGRAM_API_TOKEN`: 텔레그램 봇 토큰
- `GOOGLE_API_KEY` (또는 `GEMINI_API_KEY`): Gemini API 키
- `PLANABRAIN_ALLOWED_CHAT_IDS`: 베타 AI 허용 채팅 ID 목록
- `PLANABRAIN_ALLOWED_USER_IDS`: 베타 AI 허용 사용자 ID 목록 (1:1 대화)
- `PLANABRAIN_GEMINI_MODEL` (기본 `gemini-3-flash-preview`)
- `PLANABRAIN_GEMINI_EMBEDDING_MODEL` (기본 `gemini-embedding-001`)
- `PLANABRAIN_INDEX_PATH` (기본 `.planabrain/index.json`)
- `PLANABOT_GROUPS_PATH` (기본 `.planabot/groups.json`): 봇이 참여한 그룹 채팅 ID 저장 경로
- `PLANABOT_PLANABRAIN_REPLIES_PATH` (기본 `.planabot/planabrain_replies.json`): planabrain 답변 ID 저장 경로
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
  - `PLANABOT_RUNTIME_IMAGE=debian:buster-slim PLANABOT_RUST_IMAGE=rustlang/rust:nightly-buster PLANABOT_NODE_IMAGE=node:18-buster-slim docker compose up --build -d`

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
