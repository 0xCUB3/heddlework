#!/usr/bin/env bash
# Wraps the compiled executable and web assets in a Heddlework.app bundle and signs it when SIGN_IDENTITY is set.
set -euo pipefail

binary="${1:?path to compiled heddlework binary}"
app="${2:?output .app path}"
version="${3:-0.0.0}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/../.." && pwd)"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp "$binary" "$app/Contents/MacOS/heddlework"
chmod 755 "$app/Contents/MacOS/heddlework"
if [ -d "$root/dist/web" ]; then cp -R "$root/dist/web" "$app/Contents/MacOS/web"; fi
sed "s/__VERSION__/$version/g" "$here/Info.plist" > "$app/Contents/Info.plist"

# Rasterise the SVG icon into an icns when the macOS tools are present; the bundle still works without it.
if command -v sips >/dev/null && command -v iconutil >/dev/null && command -v qlmanage >/dev/null; then
  iconset="$(mktemp -d)/Heddlework.iconset"
  mkdir -p "$iconset"
  source_png="$(dirname "$iconset")/heddlework-icon.png"
  if command -v rsvg-convert >/dev/null; then
    rsvg-convert -w 1024 -h 1024 "$root/packaging/linux/heddlework-icon.svg" -o "$source_png" 2>/dev/null || true
  elif [ -f "$root/src/web/icon-512.png" ]; then
    sips -z 1024 1024 "$root/src/web/icon-512.png" --out "$source_png" >/dev/null 2>&1 || true
  fi
  if [ -f "$source_png" ]; then
    for size in 16 32 128 256 512; do
      sips -z "$size" "$size" "$source_png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
      double=$((size * 2))
      sips -z "$double" "$double" "$source_png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
    done
    iconutil -c icns "$iconset" -o "$app/Contents/Resources/Heddlework.icns" || true
  fi
fi

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --deep --options runtime --timestamp --entitlements "$here/entitlements.plist" --sign "$SIGN_IDENTITY" "$app"
  codesign --verify --deep --strict "$app"
  echo "Signed $app with $SIGN_IDENTITY"
else
  echo "Built unsigned $app (set SIGN_IDENTITY to sign)"
fi
