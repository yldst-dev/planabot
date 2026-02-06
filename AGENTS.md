# Repository Guidelines

## 요약
- Rust 텔레그램 봇(`core/src/`) + TS CLI(`planabrain/src/`) 구조.
- 빌드/테스트는 cargo + 필요 시 planabrain 빌드.
- 응답 메시지는 항상 프라나 톤(짧고 차분, “선생님.” 단독 줄).
- 변경 시 테스트/린트/빌드 후 푸시.

## Project Structure & Module Organization
- Rust bot lives in `core/src/` with entrypoint `core/src/main.rs`.
- Telegram handlers and routing: `core/src/bot/`.
- Gallery/Hitomi client: `core/src/hitomi/`.
- URL rewrite utilities and tests: `core/src/urlchanger/`.
- TypeScript CLI (“planabrain”) lives in `planabrain/src/`.
- Built artifacts are excluded: `target/`, `planabrain/dist/`, `planabrain/node_modules/`.
- Favor clear directory/module boundaries and design around cohesive modules.
- Split functionality by component so each unit is testable and maintainable.

## Build, Test, and Development Commands
- `cargo run` / `cargo run --release`: run the Telegram bot (requires `TELEGRAM_API_TOKEN`).
- `cargo test`: run Rust unit tests.
- `cargo fmt`: format Rust code (rustfmt).
- `cargo clippy -- -D warnings`: Rust linting with warnings as errors.
- `npm run dev` (in `planabrain/`): run the CLI with tsx.
- `npm run typecheck` (in `planabrain/`): TypeScript type check.
- `npm run build` (in `planabrain/`): compile to `planabrain/dist/`.
- Always run type checks, linting, and builds before pushing.

## Coding Style & Naming Conventions
- Rust: edition 2024, rustfmt defaults, 4-space indent, trailing commas.
- Prefer `anyhow::Result` and `?` for error propagation; avoid `unwrap`/`expect` in handlers.
- Naming: `snake_case` for functions/vars, `CamelCase` for types, `SCREAMING_SNAKE_CASE` for consts.
- User-facing strings are Korean and must use Blue Archive “Prana(프라나)” tone consistently across all features (links, error messages, bot replies).
  - Style: short sentences, “선생님.” on its own line, calm/system-like tone.
  - Prefer status lines like “정리 완료.” / “확인 완료.” / “오류.” / “불가.” / “대기 중.” where appropriate.
  - Avoid emoticons, slang, excessive warmth, and exclamation marks.
  - Escape HTML via `teloxide::utils::html` when interpolating.
- TypeScript: ESM (`"type": "module"`), NodeNext module resolution.

## Testing Guidelines
- Rust tests live alongside code (example: `core/src/urlchanger/link_utils.rs`).
- Name tests by behavior, and cover happy path + malformed inputs for parsers.
- Run with `cargo test`. There is no JS test runner currently.
- For TypeScript changes, ensure `npm run typecheck` and `npm run build` pass.

## Commit & Pull Request Guidelines
- Use Conventional Commits (`feat:`, `fix:`, `chore:`).
- PRs should include a concise summary and test evidence (`cargo test`, `cargo clippy`, `npm run typecheck` when relevant).
- Never commit secrets. Use `.env` locally; update `.env.example` for new config keys.

## Security & Configuration Tips
- AI/planabrain calls are gated by `PLANABRAIN_ALLOWED_CHAT_IDS` in `.env`.
- `TELEGRAM_API_TOKEN` and `GOOGLE_API_KEY` are required for runtime.

## CI/CD & Deployment
- GitHub Actions 워크플로우: `.github/workflows/ci.yml`
- PR/push 시 테스트 자동 실행 (Rust fmt/clippy/test + TypeScript typecheck/build)
- 테스트 통과 후에만 main/태그에서 Docker 이미지 빌드
- 이미지는 GHCR(`ghcr.io/yldst-dev/planabot`)에 푸시
- 프로덕션 서버: `docker-compose.prod.yml` + `deploy.sh` 사용
- 서버에서 빌드하지 않음 (이미지 pull만 수행)
- 롤백: `docker-compose.prod.yml`에서 이미지 태그 변경 후 재배포

## 오늘 작업 (2026-01-16)
- 프라나 톤: 봇의 모든 사용자 메시지를 프라나 말투로 통일.
- KST 인터넷 시간: worldtimeapi/timeapi/Date 헤더 기반 시간 조회 + 실패 시 로컬 fallback.
- 플래너브레인 질문: 미디어 캡션/답장 메시지를 컨텍스트로 포함.
- 플래너브레인 이미지: 캡션/답장 이미지 파일을 임시 저장 후 분석해 컨텍스트로 포함.
- 유튜브 링크: 모바일(m.youtube.com)도 처리.
- 추적 파라미터: 없는 링크에는 “제거” 메시지를 표시하지 않도록 조정.
- 프록시: 초기 로드/헬스체크 결과를 콘솔 로그로 보고.
