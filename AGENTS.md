# Repository Guidelines

## 요약
- Rust 텔레그램 봇(`core/src/`) + TS CLI(`planabrain/src/`) 구조.
- 빌드/테스트는 cargo + 필요 시 planabrain 빌드.
- 응답 메시지는 항상 프라나 톤(짧고 차분). 고정 안내문은 “선생님.”을 단독 줄로 두고, AI 답변은 필요할 때만 자연스럽게 부름.
- 변경 시 테스트/린트/빌드 후 푸시.

## Project Structure & Module Organization
- Rust bot lives in `core/src/` with entrypoint `core/src/main.rs`.
- Telegram handlers and routing: `core/src/bot/`.
- Gallery/Hitomi client: `core/src/hitomi/`.
- URL rewrite utilities and tests: `core/src/urlchanger/`.
- TypeScript CLI (“planabrain”) lives in `planabrain/src/`.
- Settings dashboard UI (React, shadcn/ui, Tailwind) lives in `dashboard/src/`; the Rust side is `core/src/dashboard/`.
- Built artifacts are excluded: `target/`, `planabrain/dist/`, `planabrain/node_modules/`, `dashboard/dist/`, `dashboard/node_modules/`.
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
- `npm run lint`, `npm run typecheck`, `npm run build` (in `dashboard/`): lint, type check, and build the settings dashboard.
- Dashboard lint runs `@shadcn/lint` through oxlint. Existing screens still carry warnings; new UI code must add none.
- Always run type checks, linting, and builds before pushing.

## Coding Style & Naming Conventions
- Rust: edition 2024, rustfmt defaults, 4-space indent, trailing commas.
- Prefer `anyhow::Result` and `?` for error propagation; avoid `unwrap`/`expect` in handlers.
- Naming: `snake_case` for functions/vars, `CamelCase` for types, `SCREAMING_SNAKE_CASE` for consts.
- User-facing strings are Korean and must use Blue Archive “Prana(프라나)” tone consistently across all features (links, error messages, bot replies).
  - Style: short sentences, calm/system-like tone.
  - Fixed bot messages (errors, statuses, schedules) put “선생님.” on its own line. AI answers address 선생님 only when it reads naturally, e.g. “선생님, 여기 있습니다.”
  - Prefer status lines like “정리 완료.” / “확인 완료.” / “오류.” / “불가.” / “대기 중.” where appropriate.
  - Avoid emoticons, slang, excessive warmth, and exclamation marks.
  - End polite requests with “~주십시오” rather than “~주세요”.
  - Escape HTML via `teloxide::utils::html` when interpolating.
- TypeScript: ESM (`"type": "module"`), NodeNext module resolution.

## Testing Guidelines
- Rust tests live alongside code (example: `core/src/urlchanger/link_utils.rs`).
- Name tests by behavior, and cover happy path + malformed inputs for parsers.
- Run with `cargo test`. In `planabrain/`, `npm test` runs the `node:test` suites through tsx.
- Seven Rust tests are `#[ignore]` and run only on request with `cargo test -- --ignored` (or by name): four need the real network (`music_card::builds_cards_from_live_links`, `music_metadata::fetches_live_metadata_for_each_platform`, `google_share::resolves_live_google_share_link`, `instagram::fetch_public_reel_preview`), two need a built planabrain (`npm run build` in `planabrain/`: `planabrain::prepare_turn_runs_against_real_cli`, `server::server_roundtrip_against_real_cli`), and `music_card::renders_card_with_local_fonts` needs `PLANABOT_MUSIC_CARD_TEST_OUTPUT` and `PLANABOT_MUSIC_CARD_TEST_COVER`. The hiromi live check is `go test -tags live ./internal/infra/hitomi`.
- For TypeScript changes, ensure `npm run typecheck` and `npm run build` pass.

## Commit & Pull Request Guidelines
- Use Conventional Commits (`feat:`, `fix:`, `chore:`).
- PRs should include a concise summary and test evidence (`cargo test`, `cargo clippy`, `npm run typecheck` when relevant).
- Never commit secrets. Use `.env` locally; update `.env.example` for new config keys.

## Security & Configuration Tips
- AI/planabrain calls are gated by `PLANABRAIN_ALLOWED_CHAT_IDS` and `PLANABRAIN_ALLOWED_USER_IDS` in `.env`: groups answer only in listed chats, a listed chat is always allowed, and private chats are allowed when the user list is empty or contains the user.
- `TELEGRAM_API_TOKEN` is required and stays in the deployment env (it is env-only in the dashboard). The model key depends on `PLANABRAIN_AI_PROVIDER`: `CODEX_GATEWAY_API_KEY` for codex, `ANTHROPIC_API_KEY` for anthropic.

## CI/CD & Deployment
- GitHub Actions 워크플로우: `.github/workflows/ci.yml`
- PR/push 시 변경된 영역만 자동 실행 (Rust fmt/clippy/test, planabrain typecheck/test/build, dashboard lint/typecheck/build, Go 모듈 gofmt/vet/test/build, Docker 이미지 빌드)
- `v*` 태그 push 시 변경 로그 기반 GitHub Release 생성
- 프로덕션 배포: Dokploy 빌드-온-푸시 (`docker-compose.dokploy.yml`)
- `main` push 시 Dokploy가 소스에서 직접 빌드 후 재배포 (GHCR 미사용)
- 상태/메모리는 명명 볼륨(`planabot-state`, `planabrain-data`)으로 영속화
