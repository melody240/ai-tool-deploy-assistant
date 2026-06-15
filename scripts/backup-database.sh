#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
BACKUP_DIR=${BACKUP_DIR:-"$ROOT/.data/backups"}
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$BACKUP_DIR/installer-$STAMP.dump"

mkdir -p "$BACKUP_DIR"
cd "$ROOT"
trap 'rm -f "$FILE"' EXIT HUP INT TERM
docker compose exec -T postgres pg_dump \
  --format=custom \
  --no-owner \
  --username=installer \
  installer > "$FILE"
chmod 600 "$FILE"
trap - EXIT HUP INT TERM

echo "$FILE"
