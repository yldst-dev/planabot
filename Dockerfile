# syntax=docker/dockerfile:1.7

## Build stage
FROM rustlang/rust:nightly-slim AS builder

WORKDIR /app

# 캐시 최적화를 위해 먼저 manifest 복사
COPY Cargo.toml Cargo.lock ./
COPY core/src ./core/src

# 릴리즈 빌드
RUN cargo build --release

## Runtime stage
FROM debian:bookworm-slim

ENV RUST_LOG=info \
    RUST_BACKTRACE=1

RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/planabot /usr/local/bin/planabot

CMD ["/usr/local/bin/planabot"]
