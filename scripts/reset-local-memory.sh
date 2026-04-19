#!/bin/sh
set -e

cd /app/planabrain
exec node dist/cli/index.js memory-reset-all
