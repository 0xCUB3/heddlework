#!/bin/bash
set -euo pipefail
if [ "$(uname -m)" != arm64 ]; then
  echo 'The Chromium Dev bundle requires an arm64 Mac' >&2
  exit 1
fi
cd "$HOME/Applications"
codesign --verify --deep --strict .heddlework-dev-staging
# Keep the previous app for recovery; never install a partially transferred bundle.
rm -rf 'Heddlework Dev.app.previous'
if [ -d 'Heddlework Dev.app' ]; then mv 'Heddlework Dev.app' 'Heddlework Dev.app.previous'; fi
if ! mv .heddlework-dev-staging 'Heddlework Dev.app'; then
  if [ -d 'Heddlework Dev.app.previous' ]; then mv 'Heddlework Dev.app.previous' 'Heddlework Dev.app'; fi
  exit 1
fi
export PATH="$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
"$HOME/.bun/bin/bun" .heddlework-dev-runtime.js
