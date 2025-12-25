# Repository Guidelines

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
- User-facing strings are Korean; escape HTML via `teloxide::utils::html` when interpolating.
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
