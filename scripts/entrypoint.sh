#!/bin/bash
set -e

# Brain 헬스체크 서버 백그라운드 실행
cd /app/planabrain && node dist/health/index.js &

# Rust 봇 실행 (포그라운드)
exec /usr/local/bin/planabot
