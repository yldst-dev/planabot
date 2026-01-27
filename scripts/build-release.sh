#!/usr/bin/env bash
set -euo pipefail

glibc_version=$(ldd --version 2>/dev/null | head -n1 | awk '{print $NF}')

debian_release="bookworm"
case "$glibc_version" in
  2.28) debian_release="buster" ;;
  2.29|2.30|2.31|2.32|2.33|2.34|2.35) debian_release="bullseye" ;;
  2.36|2.37|2.38|2.39) debian_release="bookworm" ;;
esac

debian_release="${PLANABOT_DEBIAN_RELEASE:-$debian_release}"

runtime_image="${PLANABOT_RUNTIME_IMAGE:-debian:${debian_release}-slim}"
rust_image="${PLANABOT_RUST_IMAGE:-rustlang/rust:nightly-${debian_release}}"
case "$debian_release" in
  buster) node_image="${PLANABOT_NODE_IMAGE:-node:18-buster-slim}" ;;
  bullseye) node_image="${PLANABOT_NODE_IMAGE:-node:20-bullseye-slim}" ;;
  bookworm) node_image="${PLANABOT_NODE_IMAGE:-node:20-bookworm-slim}" ;;
  *) node_image="${PLANABOT_NODE_IMAGE:-node:20-bullseye-slim}" ;;
esac

image_tag="planabot-build:${debian_release}"

echo "glibc ${glibc_version:-unknown} -> ${runtime_image}"
echo "builder image: ${rust_image}"
echo "node image: ${node_image}"

docker build \
  --build-arg RUST_IMAGE="${rust_image}" \
  --build-arg RUNTIME_IMAGE="${runtime_image}" \
  --build-arg NODE_IMAGE="${node_image}" \
  -t "${image_tag}" .

container_id=$(docker create "${image_tag}")
mkdir -p dist
docker cp "${container_id}:/usr/local/bin/planabot" dist/planabot
docker rm "${container_id}" >/dev/null

chmod +x dist/planabot
echo "saved dist/planabot"
