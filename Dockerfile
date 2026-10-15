ARG RUST_IMAGE=rust:1.86-slim-bookworm@sha256:57d415bbd61ce11e2d5f73de068103c7bd9f3188dc132c97cef4a8f62989e944
ARG RUNTIME_IMAGE=debian:bookworm-slim@sha256:7c7b2c966bc9ee8cedfeef67e0e279108992c77681fa595db4a9d65c06ccc587
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392
ARG GO_IMAGE=golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac

FROM ${RUST_IMAGE} AS builder

WORKDIR /app

COPY Cargo.toml Cargo.lock ./
RUN mkdir -p core/src && echo 'fn main() {}' > core/src/main.rs \
    && cargo build --release --locked \
    && rm -rf core/src target/release/planabot target/release/deps/planabot-* target/release/.fingerprint/planabot-*

COPY core/src ./core/src
RUN cargo build --release --locked

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

FROM ${NODE_IMAGE} AS dashboard-builder

WORKDIR /app/dashboard

COPY dashboard/package.json dashboard/package-lock.json ./
RUN npm ci

COPY dashboard/ ./
RUN npm run build

FROM ${RUNTIME_IMAGE}

ENV RUST_LOG=info \
    RUST_BACKTRACE=1 \
    HIROMI_BIN=/usr/local/bin/hiromi \
    HIROMI_DOWNLOAD_DIR=/tmp/hiromi-downloads \
    PLANABOT_MUSIC_CARD_FONT_DIR=/usr/share/fonts/opentype/noto \
    PLANABRAIN_DATA_DIR=/app \
    PLANABOT_DASHBOARD_DIR=/app/dashboard/dist

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
    rm -rf /var/lib/apt/lists/* && \
    useradd --system --uid 10001 --user-group --no-create-home --home-dir /app planabot

WORKDIR /app

COPY --from=builder /app/target/release/planabot /usr/local/bin/planabot
COPY --from=hiromi-builder /hiromi /usr/local/bin/hiromi
COPY --from=planabrain-builder /usr/local/ /usr/local/
COPY --from=planabrain-builder /app/planabrain/package.json /app/planabrain/package.json
COPY --from=planabrain-builder /app/planabrain/node_modules /app/planabrain/node_modules
COPY --from=planabrain-builder /app/planabrain/dist /app/planabrain/dist
COPY --from=dashboard-builder /app/dashboard/dist /app/dashboard/dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=5 \
    CMD node -e "const q=process.env.HEALTH_SECRET_CORE?'?secret='+encodeURIComponent(process.env.HEALTH_SECRET_CORE):'';fetch('http://127.0.0.1:'+(process.env.HEALTH_PORT||'8080')+'/health'+q).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/reset-local-memory.sh /usr/local/bin/reset-local-memory
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/reset-local-memory

CMD ["/usr/local/bin/entrypoint.sh"]
