#!/bin/zsh
# Xcode Cloud runs this after cloning. Generate the Xcode project from project.yml.
set -euo pipefail

REPO_ROOT="$CI_PRIMARY_REPOSITORY_PATH"
cd "$REPO_ROOT"

export HOMEBREW_NO_AUTO_UPDATE=1
export HOMEBREW_NO_INSTALL_CLEANUP=1
brew install xcodegen

cd packaging/ios
xcodegen generate
ls Heddlework.xcodeproj
