#!/bin/bash
set -e

cd "$(dirname "$0")"

echo "Pulling latest image..."
docker compose -f docker-compose.prod.yml pull

echo "Restarting container..."
docker compose -f docker-compose.prod.yml up -d

echo "Cleaning up old images..."
docker image prune -f

echo "Done!"
