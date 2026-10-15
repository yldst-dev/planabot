#!/bin/bash
set -e

if [ "$(id -u)" = "0" ] && id planabot >/dev/null 2>&1; then
  download_dir="${HIROMI_DOWNLOAD_DIR:-/tmp/hiromi-downloads}"
  mkdir -p /app/.planabot /app/.planabrain "$download_dir"
  if [ "$(stat -c %u /app/.planabot)" = "0" ]; then
    chown -R planabot:planabot /app/.planabot /app/.planabrain
  fi
  run_uid="$(stat -c %u /app/.planabot)"
  run_gid="$(stat -c %g /app/.planabot)"
  find /app/.planabot /app/.planabrain -uid 0 -exec chown "$run_uid:$run_gid" {} +
  chown "$run_uid:$run_gid" "$download_dir"
  export HOME=/tmp
  exec setpriv --reuid="$run_uid" --regid="$run_gid" --clear-groups /usr/local/bin/planabot
fi

exec /usr/local/bin/planabot
