#!/usr/bin/env bash
set -euo pipefail

export PLANABOT_RUNTIME_IMAGE="${PLANABOT_RUNTIME_IMAGE:-debian:bookworm-slim}"
export PLANABOT_RUST_IMAGE="${PLANABOT_RUST_IMAGE:-rust:1.86-slim-bookworm}"
export PLANABOT_NODE_IMAGE="${PLANABOT_NODE_IMAGE:-node:22-bookworm-slim}"

echo "runtime image: ${PLANABOT_RUNTIME_IMAGE}"
echo "builder image: ${PLANABOT_RUST_IMAGE}"
echo "node image: ${PLANABOT_NODE_IMAGE}"

exec docker compose up --build -d "$@"
