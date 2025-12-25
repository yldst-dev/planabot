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
  - YouTube/YouTube Music/Spotify 링크 → `si` 파라미터 제거
  - X/Twitter 링크 → `fxtwitter.com`으로 변환
  - Instagram 링크 → `kkinstagram.com`으로 변환
  관리자인 경우 원본 메시지를 삭제하고 정리된 링크로 재전송, 아니면 인라인 버튼/텍스트로 대체 링크 제공
- 봇이 재시작된 이후의 메시지만 처리합니다. (`/ping`은 예외)
- 봇 재시작 시, 이전에 기록된 그룹 채팅에 시작 안내 메시지를 전송합니다.
- 베타 AI 호출: `프라나야`로 시작하는 메시지
  - `PLANABRAIN_ALLOWED_CHAT_IDS`에 포함된 채팅 또는 `PLANABRAIN_ALLOWED_USER_IDS`에 포함된 1:1 사용자만 동작

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

## 빌드 산출물
- 릴리즈 바이너리: `target/release/planabot`

## Docker 실행 (glibc 맞춤 빌드)
- 호스트 glibc 버전에 맞춰 이미지를 선택하려면:
  - `./scripts/compose-up.sh`
- 직접 지정하려면:
  - `PLANABOT_RUNTIME_IMAGE=debian:buster-slim PLANABOT_RUST_IMAGE=rustlang/rust:nightly-buster PLANABOT_NODE_IMAGE=node:18-buster-slim docker compose up --build -d`
