# planabot

Hitomi.la 갤러리 정보 조회 + URL 정리(YouTube/Spotify si 제거, X→fxtwitter, Instagram→kkinstagram 변환)를 한 번에 처리하는 텔레그램 봇입니다. 기존 Node.js 버전을 Rust로 재작성하고, URL 체인저 기능을 통합했습니다.

## 빠른 시작
1) Rust stable 설치 후 프로젝트 루트에서 `.env` 생성/수정:
```
TELEGRAM_API_TOKEN=123456:ABC-YourRealToken
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

## 빌드 산출물
- 릴리즈 바이너리: `target/release/planabot`
