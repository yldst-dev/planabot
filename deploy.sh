#!/bin/bash
set -e

cd "$(dirname "$0")"

token=""
if [ -f .env ]; then
  token=$(grep -E '^[[:space:]]*CLOUDFLARE_TUNNEL_TOKEN=' .env | tail -n1 | cut -d= -f2- | tr -d '\r')
  token="${token#\"}"
  token="${token%\"}"
  token="${token#\'}"
  token="${token%\'}"
  token=$(printf '%s' "$token" | xargs)
fi

image_tag="${PLANABOT_IMAGE_TAG:-latest}"
if [ -f .env ]; then
  env_image_tag=$(grep -E '^[[:space:]]*PLANABOT_IMAGE_TAG=' .env | tail -n1 | cut -d= -f2- | tr -d '\r')
  env_image_tag="${env_image_tag#\"}"
  env_image_tag="${env_image_tag%\"}"
  env_image_tag="${env_image_tag#\'}"
  env_image_tag="${env_image_tag%\'}"
  env_image_tag=$(printf '%s' "$env_image_tag" | xargs)
  if [ -n "$env_image_tag" ]; then
    image_tag="$env_image_tag"
  fi
fi
export PLANABOT_IMAGE_TAG="$image_tag"

arch=$(uname -m)
platform=""
if [ "$arch" = "x86_64" ] || [ "$arch" = "amd64" ]; then
  platform="linux/amd64"
elif [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then
  platform="linux/arm64"
fi

resolve_latest_release_image_tag() {
  release_json="$(curl -fsSL https://api.github.com/repos/yldst-dev/planabot/releases/latest 2>/dev/null || true)"
  release_tag="$(printf '%s\n' "$release_json" | sed -n 's/^[[:space:]]*"tag_name":[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
  release_tag="${release_tag#v}"
  printf '%s' "$release_tag"
}

pull_with_platform() {
  if [ -n "$platform" ]; then
    DOCKER_DEFAULT_PLATFORM="$platform" docker compose -f docker-compose.prod.yml pull "$@"
  else
    docker compose -f docker-compose.prod.yml pull "$@"
  fi
}

up_with_platform() {
  if [ -n "$platform" ]; then
    DOCKER_DEFAULT_PLATFORM="$platform" docker compose -f docker-compose.prod.yml up -d "$@"
  else
    docker compose -f docker-compose.prod.yml up -d "$@"
  fi
}

if [ -n "$platform" ]; then
  echo "Detected architecture: $arch ($platform)"
else
  echo "Detected architecture: $arch (default platform)"
fi
echo "Pulling planabot image tag: ${PLANABOT_IMAGE_TAG}"
if ! pull_with_platform planabot; then
  if [ "$platform" = "linux/arm64" ] && [ "${PLANABOT_IMAGE_TAG}" = "latest" ]; then
    fallback_tag="$(resolve_latest_release_image_tag)"
    if [ -n "$fallback_tag" ] && [ "$fallback_tag" != "latest" ]; then
      export PLANABOT_IMAGE_TAG="$fallback_tag"
      echo "ARM64 latest unavailable. Fallback to release tag: ${PLANABOT_IMAGE_TAG}"
      pull_with_platform planabot
    else
      echo "Failed to resolve ARM64-compatible release tag."
      exit 1
    fi
  else
    exit 1
  fi
fi

if [ -n "$token" ]; then
  echo "Pulling cloudflared image..."
  docker compose -f docker-compose.prod.yml pull cloudflared
fi

echo "Restarting container..."
up_with_platform planabot
if [ -n "$token" ]; then
  docker compose -f docker-compose.prod.yml up -d cloudflared
fi

if [ -z "$token" ]; then
  docker compose -f docker-compose.prod.yml stop cloudflared >/dev/null 2>&1 || true
  docker compose -f docker-compose.prod.yml rm -f cloudflared >/dev/null 2>&1 || true
  echo "Cloudflared skipped (CLOUDFLARE_TUNNEL_TOKEN is empty)."
else
  echo "Cloudflared enabled."
fi

echo "Cleaning up old images..."
docker image prune -f

echo "Done!"
