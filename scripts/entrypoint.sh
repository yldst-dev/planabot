#!/bin/bash
set -e

provider="$(printf '%s' "${PLANABRAIN_AI_PROVIDER:-}" | tr '[:upper:]' '[:lower:]')"
if [ "$provider" = "geminimock" ] || [ "$provider" = "mock" ]; then
  if [ -z "${PLANABRAIN_GEMINIMOCK_BASE_URL:-}" ]; then
    if ! getent hosts host.docker.internal >/dev/null 2>&1; then
      gw_hex="$(awk '$2 == "00000000" { print $3; exit }' /proc/net/route || true)"
      if [ -n "$gw_hex" ] && [ "${#gw_hex}" -eq 8 ]; then
        gw_ip="$(printf '%d.%d.%d.%d' "0x${gw_hex:6:2}" "0x${gw_hex:4:2}" "0x${gw_hex:2:2}" "0x${gw_hex:0:2}")"
        if [ -n "$gw_ip" ]; then
          echo "$gw_ip host.docker.internal" >> /etc/hosts
        fi
      fi
    fi
    if getent hosts host.docker.internal >/dev/null 2>&1; then
      geminimock_port="${GEMINI_CLI_API_PORT:-43173}"
      export PLANABRAIN_GEMINIMOCK_BASE_URL="http://host.docker.internal:${geminimock_port}"
    fi
  fi
fi

cd /app/planabrain && node dist/health/index.js &

exec /usr/local/bin/planabot
