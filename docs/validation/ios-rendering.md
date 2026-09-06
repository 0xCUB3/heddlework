# iOS rendering, terminal, and swipe validation

This is a **local source build**, not TestFlight. Settings → Terminal → Build shows `local <version> (<build>)`. The 2026-09-06 screenshot of raw `###` headings was the old `Text(displayText:)` path.

## What changed

- Assistant and user rows use `RichMarkdownView`: headings, lists, links, inline code, fences, quotes, tables, inline/display math. Math inside code is left alone. Malformed TeX falls back to italic source.
- Draft, follow-tail, expanded traces, and last-read id persist per host+session and clear on disconnect.
- The header terminal button opens a host PTY over authenticated commands `openTerminal` / `writeTerminal` / `resizeTerminal` / `closeTerminal`.
- Sidebar sessions are a SwiftUI `List`, so leading Open and trailing Settle/Snooze (or Wake) swipe actions work. Full-swipe delete is off.

## Commands and results (2026-09-06)

```sh
bun test tests/protocol-terminal.test.ts tests/host-terminal.test.ts tests/protocol-commands.test.ts tests/protocol-browser-safe.test.ts
# 14 pass

bun run typecheck
# clean

cd packaging/ios && xcodegen generate
xcodebuild -project Heddlework.xcodeproj -scheme Heddlework \
  -destination 'platform=iOS Simulator,id=E83D7471-285E-4625-B84D-153BAC9815D3' \
  -configuration Debug test
# HeddleworkTests: all pass, including MarkdownMathTests and SessionMemoryTests
# UI: markdown+terminal 12.8s, swipe 14.0s, grouped transcript 16.3s
# host-backed skipped (no CONNECT_URL)

xcodebuild ... -destination 'id=2C5D9A2A-6DBC-4238-96DA-6FB37B61289C' \
  test-without-building -only-testing:...testFixtureRendersMarkdownAndOpensTerminal
# iPad pass, 12.7s

xcodebuild ... -configuration Release build
# BUILD SUCCEEDED
```

Simulators: iPhone `hw-iphone` `E83D7471-285E-4625-B84D-153BAC9815D3`, iPad `2C5D9A2A-6DBC-4238-96DA-6FB37B61289C`.

## Visual check

`packaging/ios/screenshots/ios-ui/fixture-markdown.png` shows **Rendered heading** (not `###`), a tappable Comment link, inline `abc1234`, a list, `E=mc²`, and display `a/b = 1`. Terminal fixture screenshot is `fixture-terminal.png`. Swipe screenshot is `fixture-session-swipe.png`.
