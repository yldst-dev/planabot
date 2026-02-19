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

services=(planabot)
if [ -n "$token" ]; then
  services+=(cloudflared)
fi

arch=$(uname -m)
platform=""
if [ "$arch" = "x86_64" ] || [ "$arch" = "amd64" ]; then
  platform="linux/amd64"
elif [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ]; then
  platform="linux/arm64"
fi

echo "Pulling latest image..."
if [ -n "$platform" ]; then
  echo "Detected architecture: $arch ($platform)"
  DOCKER_DEFAULT_PLATFORM="$platform" docker compose -f docker-compose.prod.yml pull "${services[@]}"
else
  echo "Detected architecture: $arch (default platform)"
  docker compose -f docker-compose.prod.yml pull "${services[@]}"
fi

echo "Restarting container..."
if [ -n "$platform" ]; then
  DOCKER_DEFAULT_PLATFORM="$platform" docker compose -f docker-compose.prod.yml up -d "${services[@]}"
else
  docker compose -f docker-compose.prod.yml up -d "${services[@]}"
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
