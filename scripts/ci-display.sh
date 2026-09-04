#!/usr/bin/env bash
# GitHub's hosted macOS runners come up on a 1024x768 virtual display. GPUIX opens
# offscreen test windows against that screen, so a 1280-wide test root is clamped to
# 1024 and the workbench renders its tablet layout. Switch the display to 1920x1080
# before running the UI suites. Safe to run locally; it is a no-op off macOS.
set -euo pipefail

if [ "$(uname -s)" != "Darwin" ]; then
  echo "ci-display: not macOS, nothing to do"
  exit 0
fi

if ! command -v displayplacer >/dev/null 2>&1; then
  if ! command -v brew >/dev/null 2>&1; then
    echo "ci-display: displayplacer and brew both missing, leaving the display alone"
    exit 0
  fi
  brew install displayplacer >/dev/null
fi

id=$(displayplacer list | awk '/Persistent screen id/ { print $4; exit }')
if [ -z "$id" ]; then
  echo "ci-display: no display found"
  exit 0
fi

for res in 1920x1080 1600x1200 1600x900 1344x1008 1280x960; do
  if displayplacer "id:$id res:$res" >/dev/null 2>&1; then
    echo "ci-display: display $id set to $res"
    exit 0
  fi
done

echo "ci-display: no larger mode accepted, current modes:"
displayplacer list | grep -E 'mode [0-9]+' || true
