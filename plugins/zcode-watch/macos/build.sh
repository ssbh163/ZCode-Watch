#!/bin/bash
# ============================================================================
# 文件作用：把 ZCodeWatchHUD.swift 编译并打包成 macOS 应用包 ZCodeWatchHUD.app
#
# 为什么这样做：
#   - 打成 .app 才能设置 LSUIElement=true（不占 Dock、不抢焦点）
#   - 打成 .app 才能用 `open -g` 做「已运行则唤出」的幂等启动
#   - ad-hoc 签名让应用有稳定身份，避免每次重建后系统重复询问权限
#   - 顺带把查询脚本从 skills 正本同步到 scripts/（.app 旁边），
#     让「整个 macos 目录分享给别人」的机器不装 ZCode 也能查
#
# 用法：cd 本目录后执行  bash build.sh
# ============================================================================
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$DIR/ZCodeWatchHUD.app"
NAME="ZCodeWatchHUD"

echo "==> 清理旧的应用包"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# 同步查询脚本：正本在 ../skills/zcode-watch/scripts/（插件 hook/CLI 用的都是它）
echo "==> 同步查询脚本"
MJS_SRC="$DIR/../skills/zcode-watch/scripts/zcode-watch.mjs"
if [ -f "$MJS_SRC" ]; then
  mkdir -p "$DIR/scripts"
  cp "$MJS_SRC" "$DIR/scripts/zcode-watch.mjs"
  echo "    scripts/zcode-watch.mjs 已从 skills 正本同步"
elif [ -f "$DIR/scripts/zcode-watch.mjs" ]; then
  echo "    未找到 skills 正本（独立目录），沿用现有 scripts/zcode-watch.mjs"
else
  echo "    ⚠ 两个位置都没有查询脚本；悬浮窗将依赖 ZCode 插件缓存里的副本"
fi

echo "==> 编译 Swift 源码"
swiftc -O -swift-version 5 \
  -framework AppKit -framework Carbon \
  "$DIR/$NAME.swift" \
  -o "$APP/Contents/MacOS/$NAME"

echo "==> 写入 Info.plist"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key>
    <string>ZCodeWatchHUD</string>
    <key>CFBundleIdentifier</key>
    <string>com.zcode-watch.hud</string>
    <key>CFBundleName</key>
    <string>zcode-watch</string>
    <key>CFBundleDisplayName</key>
    <string>zcode-watch 多 Key 用量</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>0.4.0</string>
    <key>CFBundleVersion</key>
    <string>1</string>
    <key>LSUIElement</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

echo "==> ad-hoc 签名"
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "   （签名失败，不影响本机运行）"

echo "==> 完成：$APP"
echo "    启动：open $APP"
