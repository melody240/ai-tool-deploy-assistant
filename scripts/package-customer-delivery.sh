#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
VERSION=1.0.0
CC_SWITCH_VERSION=3.16.2
STAGING="$ROOT/release/customer-delivery/macos-arm64"
OUTPUT="$ROOT/release/customer-delivery/AI工具部署助手-客户交付包-macOS-${VERSION}.zip"
APP_DMG="$ROOT/apps/desktop/src-tauri/target/release/bundle/dmg/AI 工具部署助手_${VERSION}_aarch64.dmg"
CC_SWITCH_DMG="$ROOT/vendor-downloads/cc-switch/${CC_SWITCH_VERSION}/CC-Switch-v${CC_SWITCH_VERSION}-macOS.dmg"
MANUAL_PDF="$ROOT/release/manual/AI工具部署助手-客户交付与使用手册.pdf"

for required in "$APP_DMG" "$CC_SWITCH_DMG" "$MANUAL_PDF"; do
  if [ ! -f "$required" ]; then
    echo "Required delivery file is missing: $required" >&2
    exit 1
  fi
done

rm -rf "$STAGING"
mkdir -p "$STAGING/配套工具" "$STAGING/文档" "$STAGING/开源许可证"

cp "$APP_DMG" "$STAGING/"
cp "$CC_SWITCH_DMG" "$STAGING/配套工具/"
cp "$MANUAL_PDF" "$STAGING/文档/"
cp "$ROOT/vendor-downloads/cc-switch/${CC_SWITCH_VERSION}/LICENSE" \
  "$STAGING/开源许可证/CC-Switch-MIT-LICENSE.txt"

cat > "$STAGING/交付说明.txt" <<'EOF'
AI 工具部署助手客户交付包

1. 先阅读“文档/AI工具部署助手-客户交付与使用手册.pdf”。
2. 当前主程序仅适用于 Apple 芯片 Mac，系统要求以手册为准。
3. 激活码不放在压缩包中，由卖家在订单聊天中单独发送。
4. 本产品不包含 AI 账号、API Key、模型额度、代理或地区限制绕过服务。
5. CC Switch 为 MIT 开源第三方配套工具，版权和许可证见“开源许可证”目录。
EOF

(
  cd "$STAGING"
  shasum -a 256 \
    "AI 工具部署助手_${VERSION}_aarch64.dmg" \
    "配套工具/CC-Switch-v${CC_SWITCH_VERSION}-macOS.dmg" \
    "文档/AI工具部署助手-客户交付与使用手册.pdf" \
    > SHA256SUMS.txt
)

rm -f "$OUTPUT"
(
  cd "$(dirname "$STAGING")"
  ditto -c -k --sequesterRsrc --keepParent "$(basename "$STAGING")" "$OUTPUT"
)

echo "$OUTPUT"
