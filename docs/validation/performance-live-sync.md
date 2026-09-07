# Performance and live-sync validation

Validated on the development Mac on September 7, 2026. Baseline for the implementation was `429cee9`; the final code/test revision was `9c63a4f`.

## Checks

| Check | Result |
| --- | --- |
| Desktop TypeScript | Passed |
| Web TypeScript | Passed |
| Full Bun suite with real-Pi opt-in enabled | 684 passed, 0 failed; 3,813 assertions across 150 files |
| Packaged macOS app and bundled web client | Built successfully; ad-hoc signature verification passed |
| Packaged Chromium smoke | Passed: 8 requests, isolated profiles, ordered commands, sandboxed helpers, teardown and clean shutdown |
| iOS app, unit-test target and UI-test target | `build-for-testing` succeeded for the iOS Simulator SDK |
| Whitespace/error check | `git diff --check` passed |

The real-Pi tests use an isolated agent/runtime directory and an offline extension command. They verify auto-loading, owner attachment, state/history operations and terminal/app mutations against the same Pi process without issuing a paid model request. Socket fixtures additionally cover mid-response snapshots, event ordering, reconnects, stale identities, duplicate suppression and Unicode/control handling.

## Performance evidence

The checked-in native Settings benchmark measured **840.4 ms for 200 synthetic wheel events** in the final run, versus the recorded like-for-like baseline of **1,361.1 ms**. This is approximately 38% less dispatch time. The earlier post-fix run was 879.2 ms; see [the Settings benchmark notes](settings-performance.md) for methodology and run-to-run variation. This measures synthetic dispatch, not sustained display FPS or a guarantee against every frame hitch.

The Settings regression suite verifies that unrelated agent activity does not re-render the Settings component and that terminal appearance controls subscribe to structural state instead of terminal frames. The live bridge stress regression receives all 200 growing-response updates while keeping their serialized payload below 300 KB for 200 KB of new text; cumulative assistant snapshots are retained privately for attachment, not resent with every token. Idle historical sessions are restored without spawning a Pi process per saved thread.

## Reproduce

```sh
HEDDLEWORK_TEST_PI="$(command -v pi)" bun run check
bun scripts/benchmark-settings-scroll.tsx
bun run build
bun run smoke:browser
xcodebuild -project packaging/ios/Heddlework.xcodeproj -scheme Heddlework \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build-for-testing
```

## Limits and activation

Linux/Windows execution and on-device iOS scrolling were not measured on this Mac. The iOS result is a build result, not an executed XCTest or device-performance result.

The rebuilt app is `dist/Heddlework.app`. Validation did not restart the user's running agents or replace an installed application. Existing workspace runtimes must be restarted when their current work can safely stop to load backend changes. Existing Pi TUI processes must load the new bridge with `/reload` or a restart before being opened in Heddlework. For app-owned sessions, use the [terminal attach client](../terminal-attach.md), not a second `pi --session` writer.
