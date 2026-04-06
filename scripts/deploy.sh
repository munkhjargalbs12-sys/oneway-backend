#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BRANCH="${1:-main}"

cd "$ROOT_DIR"

if [[ ! -d .git ]]; then
  echo "This deploy script must run inside a git clone."
  exit 1
fi

if [[ ! -f .env ]]; then
  echo ".env file is missing in $ROOT_DIR"
  exit 1
fi

echo "Fetching latest code from origin/$BRANCH"
git fetch origin "$BRANCH"
git checkout "$BRANCH"
git pull --ff-only origin "$BRANCH"

echo "Installing production dependencies"
npm install --omit=dev

set -a
. ./.env
set +a

if [[ -z "${DB_HOST:-}" || -z "${DB_PORT:-}" || -z "${DB_NAME:-}" || -z "${DB_USER:-}" ]]; then
  echo "DB_HOST, DB_PORT, DB_NAME, and DB_USER must be set in .env"
  exit 1
fi

echo "Applying database compatibility updates"
PGPASSWORD="${DB_PASSWORD:-}" psql \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  -f sql/init.sql

echo "Reloading PM2 process"
if pm2 describe oneway-api >/dev/null 2>&1; then
  pm2 reload ecosystem.config.js --only oneway-api --update-env
else
  pm2 start ecosystem.config.js --only oneway-api
fi

pm2 save
pm2 status oneway-api
