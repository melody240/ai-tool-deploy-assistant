#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=$(node -p "require('$ROOT/package.json').version")
OUTPUT_DIR="$ROOT/.data/releases"
STAGING="$OUTPUT_DIR/windows-server-$VERSION"
ARCHIVE="$OUTPUT_DIR/ai-tool-server-$VERSION-windows.zip"

cd "$ROOT"
npm run build -w @ai-tool-installer/shared
npm run build -w @ai-tool-installer/api

rm -rf "$STAGING" "$ARCHIVE"
mkdir -p \
  "$STAGING/payload/services/api" \
  "$STAGING/payload/packages/shared" \
  "$STAGING/payload/scripts" \
  "$STAGING/payload/config" \
  "$STAGING/payload/deploy"

cp package.json "$STAGING/payload/package.json"
cp services/api/package.json "$STAGING/payload/services/api/package.json"
cp -R services/api/dist "$STAGING/payload/services/api/dist"
cp -R services/api/public "$STAGING/payload/services/api/public"
cp packages/shared/package.json "$STAGING/payload/packages/shared/package.json"
cp -R packages/shared/dist "$STAGING/payload/packages/shared/dist"
cp scripts/configure-windows-production.mjs "$STAGING/payload/scripts/"
cp apps/desktop/src-tauri/resources/license-public-key.b64 \
  "$STAGING/payload/config/license-public-key.b64"
cp deploy/install-windows-release.ps1 "$STAGING/payload/deploy/"
cp deploy/install-caddy-windows.ps1 "$STAGING/payload/deploy/"

(
  cd "$STAGING"
  zip -q -r "$ARCHIVE" payload
)
rm -rf "$STAGING"

shasum -a 256 "$ARCHIVE"
echo "Windows server package: $ARCHIVE"
