#!/bin/bash
# Renders the Homebrew cask and Scoop manifest for a release from checksums.txt and pushes them to the tap and bucket.
# Usage: scripts/release-packages.sh <tag> <checksums.txt> [--dry-run]
# Needs PACKAGES_TOKEN (a token with push access to 0xCUB3/homebrew-heddlework and 0xCUB3/scoop-heddlework) unless --dry-run.
set -euo pipefail

tag="$1"
checksums="$2"
dry_run="${3:-}"
version="${tag#v}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${OUT_DIR:-$root/dist/packages}"
mkdir -p "$out"

sha_for() { awk -v f="$1" '$2 == f {print $1}' "$checksums"; }

sha_arm="$(sha_for heddlework-macos-arm64.zip)"
sha_x64="$(sha_for heddlework-macos-x64.zip)"
win_asset=heddlework-windows-x64.zip
sha_win="$(sha_for "$win_asset")"
if [ -z "$sha_win" ]; then win_asset=heddlework-windows-x64-unsigned.zip; sha_win="$(sha_for "$win_asset")"; fi

for v in sha_arm sha_x64 sha_win; do
  [ -n "${!v}" ] || { echo "missing checksum for $v in $checksums"; exit 1; }
done

sed -e "s|@VERSION@|$version|g" -e "s|@SHA_ARM64@|$sha_arm|g" -e "s|@SHA_X64@|$sha_x64|g" \
  "$root/packaging/homebrew/heddlework.rb.tmpl" > "$out/heddlework.rb"
sed -e "s|@VERSION@|$version|g" -e "s|@WIN_ASSET@|$win_asset|g" -e "s|@SHA_WIN@|$sha_win|g" \
  "$root/packaging/windows/heddlework.json.tmpl" > "$out/heddlework.json"

echo "rendered $out/heddlework.rb and $out/heddlework.json for $version"

# Prereleases are published as GitHub releases only; package managers track stable tags.
case "$version" in *-*) echo "prerelease $version: not publishing to the tap or bucket"; exit 0 ;; esac
[ "$dry_run" = "--dry-run" ] && exit 0

: "${PACKAGES_TOKEN:?PACKAGES_TOKEN is required to push}"
push_file() {
  local repo="$1" path="$2" src="$3" work
  work="$(mktemp -d)"
  git clone -q --depth 1 "https://x-access-token:${PACKAGES_TOKEN}@github.com/0xCUB3/${repo}.git" "$work"
  mkdir -p "$work/$(dirname "$path")"
  cp "$src" "$work/$path"
  git -C "$work" add "$path"
  if git -C "$work" diff --cached --quiet; then echo "$repo: $path already at $version"; return; fi
  git -C "$work" -c user.name="heddlework-release" -c user.email="release@heddlework.invalid" commit -qm "heddlework $version"
  git -C "$work" push -q origin HEAD
  echo "$repo: pushed $path for $version"
}

push_file homebrew-heddlework Casks/heddlework.rb "$out/heddlework.rb"
push_file scoop-heddlework bucket/heddlework.json "$out/heddlework.json"
