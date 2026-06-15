#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 path/to/installer.dump" >&2
  exit 1
fi

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
FILE=$1

if [ ! -f "$FILE" ]; then
  echo "Backup not found: $FILE" >&2
  exit 1
fi

cd "$ROOT"
docker compose stop api
trap 'docker compose start api >/dev/null 2>&1 || true' EXIT HUP INT TERM
docker compose exec -T postgres pg_restore \
  --clean \
  --if-exists \
  --no-owner \
  --username=installer \
  --dbname=installer < "$FILE"

docker compose start api
trap - EXIT HUP INT TERM
echo "Database restored from $FILE"
