#!/usr/bin/env bash
set -euo pipefail

glibc_version=$(ldd --version 2>/dev/null | head -n1 | awk '{print $NF}')

debian_release="bookworm"
case "$glibc_version" in
  2.28) debian_release="buster" ;;
  2.31) debian_release="bullseye" ;;
  2.36|2.37) debian_release="bookworm" ;;
esac

export PLANABOT_RUNTIME_IMAGE="debian:${debian_release}-slim"
export PLANABOT_RUST_IMAGE="${PLANABOT_RUST_IMAGE:-rustlang/rust:nightly-${debian_release}}"
case "$debian_release" in
  buster) PLANABOT_NODE_IMAGE="${PLANABOT_NODE_IMAGE:-node:18-buster-slim}" ;;
  bullseye) PLANABOT_NODE_IMAGE="${PLANABOT_NODE_IMAGE:-node:20-bullseye-slim}" ;;
  bookworm) PLANABOT_NODE_IMAGE="${PLANABOT_NODE_IMAGE:-node:20-bookworm-slim}" ;;
esac

echo "glibc ${glibc_version:-unknown} -> ${PLANABOT_RUNTIME_IMAGE}"
echo "builder image: ${PLANABOT_RUST_IMAGE}"
echo "node image: ${PLANABOT_NODE_IMAGE}"

exec docker compose up --build -d "$@"
