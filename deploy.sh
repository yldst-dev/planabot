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

echo "Pulling latest image..."
docker compose -f docker-compose.prod.yml pull "${services[@]}"

echo "Restarting container..."
docker compose -f docker-compose.prod.yml up -d "${services[@]}"

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
