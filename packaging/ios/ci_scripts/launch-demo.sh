#!/usr/bin/env bash
set -euo pipefail

UDID="${1:-${SIMULATOR_UDID:-}}"
if [ -z "$UDID" ]; then
  UDID="$(xcrun simctl list devices booted | sed -n 's/.*(\([0-9A-F-][0-9A-F-]*\)) (Booted).*/\1/p' | head -1)"
  if [ -z "$UDID" ]; then echo "No booted simulator; pass UDID or set SIMULATOR_UDID" >&2; exit 1; fi
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
IOS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -z "${APP_PATH:-}" ]; then
  DERIVED_DATA="$IOS_DIR/build/DerivedData"
  xcodebuild -project "$IOS_DIR/Heddlework.xcodeproj" -scheme Heddlework -destination "id=$UDID" -derivedDataPath "$DERIVED_DATA" build >/tmp/heddlework-ios-demo-build.log
  APP_PATH="$DERIVED_DATA/Build/Products/Debug-iphonesimulator/Heddlework.app"
fi
if [ ! -d "$APP_PATH" ]; then echo "APP_PATH does not exist: $APP_PATH" >&2; exit 1; fi

: "${CONNECT_URL:?Set CONNECT_URL to the demo host connect link}"
SCREENSHOT_DIR="${SCREENSHOT_DIR:-$IOS_DIR/screenshots}"
mkdir -p "$SCREENSHOT_DIR"
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP_PATH"
xcrun simctl terminate "$UDID" com.0xCUBE.Heddlework >/dev/null 2>&1 || true
xcrun simctl spawn "$UDID" defaults write com.0xCUBE.Heddlework heddlework.connectLink "$CONNECT_URL"
xcrun simctl launch "$UDID" com.0xCUBE.Heddlework
sleep 3
xcrun simctl io "$UDID" screenshot "$SCREENSHOT_DIR/iphone-chat-connecting.png"
if [ "${DEMO_DEEPLINK:-0}" = "1" ]; then
  ENCODED_URL="$(python3 - "$CONNECT_URL" <<'PY'
import sys, urllib.parse
print(urllib.parse.quote(sys.argv[1], safe=''))
PY
)"
  xcrun simctl openurl "$UDID" "heddlework://connect?url=$ENCODED_URL"
  sleep 3
  xcrun simctl io "$UDID" screenshot "$SCREENSHOT_DIR/iphone-deeplink-prompt-or-connecting.png"
fi
echo "Installed Heddlework.app on $UDID"
echo "App path: $APP_PATH"
echo "Seeded connect link with redacted token"
echo "Set DEMO_DEEPLINK=1 to invoke heddlework://connect; iOS may show the first-open confirmation prompt."
echo "Screenshots written to $SCREENSHOT_DIR"
