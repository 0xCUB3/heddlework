#!/usr/bin/env bash
# Builds the patched GPUix packages that Heddlework's native terminal and Chromium panel need, then packs them
# into vendor/gpuix as the tarballs package.json points at. Needs Rust, cmake, ninja, and the Xcode Metal toolchain
# (xcodebuild -downloadComponent MetalToolchain). Run scripts/fetch-gpuix.sh instead to use the prebuilt release.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
gpuix_tag="@gpuix/native@0.7.0"
build_version="${GPUIX_BUILD_VERSION:-0.7.0-heddlework.1}"
checkout="${GPUIX_CHECKOUT:-$root/../gpuix-heddlework-0.7}"
patch="$root/patches/gpuix-0.7.0-heddlework.patch"
out="$root/vendor/gpuix"

if [ ! -d "$checkout/.git" ]; then
  git clone --depth 1 --branch "$gpuix_tag" https://github.com/remorses/gpuix "$checkout"
  git -C "$checkout" submodule update --init --depth 1 --recursive zed
fi

# The patch has two sections: everything before the first crates/gpui hunk applies at the GPUix root, the rest inside zed/.
split="$(grep -n '^diff --git a/crates/gpui' "$patch" | head -1 | cut -d: -f1)"
root_patch="$(mktemp)"; zed_patch="$(mktemp)"
sed -n "1,$((split - 1))p" "$patch" > "$root_patch"
sed -n "${split},\$p" "$patch" > "$zed_patch"
if git -C "$checkout" apply --check "$root_patch" 2>/dev/null; then git -C "$checkout" apply "$root_patch"; else echo "[gpuix] root patch already applied"; fi
if git -C "$checkout/zed" apply --check "$zed_patch" 2>/dev/null; then git -C "$checkout/zed" apply "$zed_patch"; else echo "[gpuix] zed patch already applied"; fi
rm -f "$root_patch" "$zed_patch"

(cd "$checkout" && bun install)
(cd "$checkout/packages/native" && bun run build:browser)
(cd "$checkout/packages/react" && bun run build)

mkdir -p "$out"
rm -f "$out"/*.tgz

# Pack with a Heddlework-specific version so the react package's dependency on native resolves through the override in package.json.
pack() {
  local directory="$1" edit="$2"
  cp "$directory/package.json" "$directory/package.json.orig"
  (cd "$directory" && bun -e "$edit" && npm pack --pack-destination "$out" >/dev/null)
  mv "$directory/package.json.orig" "$directory/package.json"
}
pack "$checkout/packages/native" "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='$build_version';p.files.push('gpuix-native.darwin-arm64.node');delete p.scripts.prepublishOnly;p.optionalDependencies={'@gpuix/native-darwin-x64':'0.7.0','@gpuix/native-linux-x64-gnu':'0.7.0','@gpuix/native-win32-x64-msvc':'0.7.0'};fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"
pack "$checkout/packages/react" "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version='$build_version';p.dependencies['@gpuix/native']='$build_version';fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n')"

(cd "$root" && shasum -a 256 vendor/gpuix/*.tgz > vendor/gpuix/SHA256SUMS && cat vendor/gpuix/SHA256SUMS)
echo "[gpuix] packed $build_version into $out; run bun install to pick it up"
