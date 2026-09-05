#!/bin/zsh
# Xcode Cloud runs this after cloning. Install Bun, build the web client, and generate the Xcode project.
set -euo pipefail

REPO_ROOT="$CI_PRIMARY_REPOSITORY_PATH"
cd "$REPO_ROOT"

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
brew install oven-sh/bun/bun xcodegen

bun install --frozen-lockfile
bun run build:web
test -f dist/web/index.html

cd packaging/ios
xcodegen generate
ls Heddlework.xcodeproj
