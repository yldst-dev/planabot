# syntax=docker/dockerfile:1.7

ARG RUST_IMAGE=rust:1.86-slim-bookworm
ARG RUNTIME_IMAGE=debian:bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim
ARG GO_IMAGE=golang:1.24-bookworm

FROM ${RUST_IMAGE} AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
COPY core/src ./core/src

RUN cargo build --release

FROM ${GO_IMAGE} AS hiromi-builder

WORKDIR /src
COPY send-vis-ee-api ./send-vis-ee-api
COPY hiromi ./hiromi
WORKDIR /src/hiromi
ENV CGO_ENABLED=0
RUN go build -o /hiromi ./cmd/hiromi

FROM ${NODE_IMAGE} AS planabrain-builder

WORKDIR /app/planabrain

COPY planabrain/package.json planabrain/package-lock.json ./
RUN npm ci

COPY planabrain/tsconfig.json ./
COPY planabrain/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${RUNTIME_IMAGE}

ENV RUST_LOG=info \
    RUST_BACKTRACE=1 \
    GEMINI_CLI_API_HOST=host.docker.internal \
    GEMINI_CLI_API_PORT=43173 \
    HIROMI_BIN=/usr/local/bin/hiromi \
    HIROMI_DOWNLOAD_DIR=/tmp/hiromi-downloads \
    PLANABOT_MUSIC_CARD_FONT_DIR=/usr/share/fonts/opentype/noto

RUN if grep -q "VERSION_CODENAME=buster" /etc/os-release; then \
        sed -i 's|deb.debian.org/debian|archive.debian.org/debian|g' /etc/apt/sources.list && \
        sed -i 's|security.debian.org/debian-security|archive.debian.org/debian-security|g' /etc/apt/sources.list && \
        sed -i '/buster-updates/d' /etc/apt/sources.list && \
        apt-get -o Acquire::Check-Valid-Until=false update; \
    else \
        apt-get update; \
    fi && \
    apt-get install -y --no-install-recommends ca-certificates fonts-noto-cjk && \
    rm -f /usr/share/fonts/opentype/noto/NotoSerifCJK-*.ttc && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /app/target/release/planabot /usr/local/bin/planabot
COPY --from=hiromi-builder /hiromi /usr/local/bin/hiromi
COPY --from=planabrain-builder /usr/local/ /usr/local/
COPY --from=planabrain-builder /app/planabrain/package.json /app/planabrain/package.json
COPY --from=planabrain-builder /app/planabrain/node_modules /app/planabrain/node_modules
COPY --from=planabrain-builder /app/planabrain/dist /app/planabrain/dist

EXPOSE 8080 8081

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/reset-local-memory.sh /usr/local/bin/reset-local-memory
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/reset-local-memory

CMD ["/usr/local/bin/entrypoint.sh"]
