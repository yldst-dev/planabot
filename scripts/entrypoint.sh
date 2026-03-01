#!/bin/bash
set -e

provider="$(printf '%s' "${PLANABRAIN_AI_PROVIDER:-}" | tr '[:upper:]' '[:lower:]')"
if [ "$provider" = "geminimock" ] || [ "$provider" = "mock" ]; then
  geminimock_base="${PLANABRAIN_GEMINIMOCK_BASE_URL:-}"
  geminimock_host="${GEMINI_CLI_API_HOST:-}"
  geminimock_port="${GEMINI_CLI_API_PORT:-43173}"
  needs_host_alias=0

  if [ -n "$geminimock_base" ]; then
    base_host="$(printf '%s' "$geminimock_base" | sed -E 's#^[a-zA-Z]+://([^/:]+).*#\1#')"
    if [ "$base_host" = "host.docker.internal" ]; then
      needs_host_alias=1
    fi
  else
    if [ -z "$geminimock_host" ] || [ "$geminimock_host" = "host.docker.internal" ]; then
      needs_host_alias=1
    fi
  fi

  if [ "$needs_host_alias" -eq 1 ] && ! getent hosts host.docker.internal >/dev/null 2>&1; then
    gw_hex="$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route || true)"
    if [ -n "$gw_hex" ] && [ "${#gw_hex}" -eq 8 ]; then
      gw_ip="$(printf '%d.%d.%d.%d' "0x${gw_hex:6:2}" "0x${gw_hex:4:2}" "0x${gw_hex:2:2}" "0x${gw_hex:0:2}")"
      if [ -n "$gw_ip" ]; then
        echo "$gw_ip host.docker.internal" >> /etc/hosts
      fi
    fi
  fi

  if [ -z "$geminimock_base" ] && getent hosts host.docker.internal >/dev/null 2>&1; then
    export PLANABRAIN_GEMINIMOCK_BASE_URL="http://host.docker.internal:${geminimock_port}"
  fi
fi

cd /app/planabrain && node dist/health/index.js &

exec /usr/local/bin/planabot
