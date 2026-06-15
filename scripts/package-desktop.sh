#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
PRIVATE_KEY=${TAURI_SIGNING_PRIVATE_KEY:-"$ROOT/.secrets/updater-private.key"}

if [ ! -f "$PRIVATE_KEY" ]; then
  echo "Updater signing key not found: $PRIVATE_KEY" >&2
  exit 1
fi

cd "$ROOT"
node scripts/release-check.mjs

export TAURI_SIGNING_PRIVATE_KEY="$PRIVATE_KEY"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}
npm exec -w @ai-tool-installer/desktop tauri build
