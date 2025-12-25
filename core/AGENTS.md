# Repository Guidelines

## Project Structure & Modules
- `src/main.rs`: entry point; loads config, builds bot state, launches dispatcher.
- `src/bot.rs`: Telegram command/message/callback handlers and router setup.
- `src/config.rs`: `.env` loading and template creation for `TELEGRAM_API_TOKEN`.
- `src/hitomi/`: Hitomi client and parser for gallery lookups.
- `src/urlchanger/`: URL rewrite handlers plus `link_utils.rs` utilities and unit tests.
- `target/`: build outputs; exclude from PRs. Docker assets: `Dockerfile`, `docker-compose.yml`.

## Build, Test, Development
- `cargo run --release`: run bot locally (requires `TELEGRAM_API_TOKEN` in `.env`).
- `cargo run`: faster debug build during iteration.
- `cargo test`: execute Rust tests (currently URL changer; add coverage with new code).
- `cargo fmt`: apply rustfmt.
- `cargo clippy -- -D warnings`: lint with warnings treated as errors.
- `docker compose up --build -d`: build and run containerized bot using the mounted `.env`.

## Coding Style & Naming
- Rust 2024 edition; default rustfmt (4-space indent, trailing commas, sorted uses).
- Prefer `anyhow::Result` and `?` for propagation; log with `log` macros instead of panicking.
- Avoid `unwrap`/`expect` in handlers; handle and surface user-friendly messages.
- Naming: functions/vars `snake_case`, types `CamelCase`, constants `SCREAMING_SNAKE_CASE`.
- User-facing strings are Korean; escape HTML via `teloxide::utils::html` when interpolating.

## Testing Guidelines
- Place unit tests alongside code (pattern in `src/urlchanger/link_utils.rs`).
- Name tests by behavior (`test_convert_x_links_rewrites_host`); prefer table-driven inputs.
- Cover happy path, malformed URLs, and error branches for new parsers/clients.
- For network-facing code, abstract HTTP behind traits so clients can be mocked; avoid live Hitomi calls in CI.

## Commit & PR Guidelines
- Use Conventional Commits (`feat:`, `fix:`, `chore:`, etc.) as in repo history.
- Keep PRs focused; include summary of behavior change and risks.
- Provide evidence: `cargo test`, `cargo clippy`, and `cargo fmt` outputs; add Telegram screenshots when text/UX changes.
- Link related issues; request review before merge. Never commit secrets—`.env` stays local/bind-mounted.
