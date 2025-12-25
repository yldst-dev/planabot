# syntax=docker/dockerfile:1.7

ARG RUST_IMAGE=rustlang/rust:nightly-slim
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG NODE_IMAGE=node:20-bookworm-slim
ARG RUSTUP_TOOLCHAIN=nightly

## Build stage
FROM ${RUST_IMAGE} AS builder

WORKDIR /app

# Ensure toolchain is new enough for current dependencies.
RUN rustup update ${RUSTUP_TOOLCHAIN} && rustup default ${RUSTUP_TOOLCHAIN}

# 캐시 최적화를 위해 먼저 manifest 복사
COPY Cargo.toml Cargo.lock ./
COPY core/src ./core/src

# 릴리즈 빌드
RUN cargo build --release

## Planabrain build stage
FROM ${NODE_IMAGE} AS planabrain-builder

WORKDIR /app/planabrain

COPY planabrain/package.json planabrain/package-lock.json ./
RUN npm ci

COPY planabrain/tsconfig.json ./
COPY planabrain/src ./src
RUN npm run build && npm prune --omit=dev

## Runtime stage
FROM ${RUNTIME_IMAGE}

ENV RUST_LOG=info \
    RUST_BACKTRACE=1

RUN if grep -q "VERSION_CODENAME=buster" /etc/os-release; then \
        sed -i 's|deb.debian.org/debian|archive.debian.org/debian|g' /etc/apt/sources.list && \
        sed -i 's|security.debian.org/debian-security|archive.debian.org/debian-security|g' /etc/apt/sources.list && \
        sed -i '/buster-updates/d' /etc/apt/sources.list && \
        apt-get -o Acquire::Check-Valid-Until=false update; \
    else \
        apt-get update; \
    fi && \
    apt-get install -y --no-install-recommends ca-certificates && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/planabot /usr/local/bin/planabot
COPY --from=planabrain-builder /usr/local/ /usr/local/
COPY --from=planabrain-builder /app/planabrain/package.json /app/planabrain/package.json
COPY --from=planabrain-builder /app/planabrain/node_modules /app/planabrain/node_modules
COPY --from=planabrain-builder /app/planabrain/dist /app/planabrain/dist

CMD ["/usr/local/bin/planabot"]
