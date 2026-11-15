#!/bin/sh
set -e

cd /app/planabrain

if [ "$(id -u)" = "0" ]; then
  run_uid="$(stat -c %u /app/.planabot)"
  run_gid="$(stat -c %g /app/.planabot)"
  if [ "$run_uid" = "0" ]; then
    printf '선생님.\n오류. 데이터 폴더 소유자가 root라서 초기화할 수 없습니다.\n컨테이너를 다시 시작한 뒤 실행하십시오.\n' >&2
    exit 1
  fi
  exec setpriv --reuid="$run_uid" --regid="$run_gid" --clear-groups node dist/cli/index.js memory-reset-all
fi

exec node dist/cli/index.js memory-reset-all
