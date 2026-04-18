#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "Usage: ./scripts/release-ghcr.sh <version>"
  exit 1
fi

raw_version="$1"
version="${raw_version#v}"
image="ghcr.io/yldst-dev/planabot"
platforms="${PLATFORMS:-linux/amd64,linux/arm64}"
push_latest="${PUSH_LATEST:-1}"
gh_user="${GHCR_USER:-${GITHUB_USER:-}}"
gh_token="${GHCR_TOKEN:-${GITHUB_TOKEN:-}}"

if [ -z "$gh_user" ]; then
  gh_user="$(gh api user -q .login)"
fi

if [ -z "$gh_token" ]; then
  gh_token="$(gh auth token)"
fi

printf '%s' "$gh_token" | docker login ghcr.io -u "$gh_user" --password-stdin >/dev/null

tags=(-t "${image}:${version}")
if [ "$push_latest" != "0" ]; then
  tags+=(-t "${image}:latest")
fi

docker buildx build \
  --platform "${platforms}" \
  "${tags[@]}" \
  --push \
  .
