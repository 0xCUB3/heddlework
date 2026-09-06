# Transcript grouping, scroll, and mobile layout

Authority remains GPUix `src/ui` plus the shared projector in `src/ui/transcript-projection.ts`. iOS SwiftUI ports that projector and is checked against `tests/fixtures/transcript-projection.json`.

## What changed

- iOS projects the same work-trace rows as desktop: collapsed **Worked for …** / **Working**, tools and thinking inside, final answer outside.
- Opening a chat uses a bottom scroll anchor. Session switches reset follow-tail. Manual drags stop following; **Jump to latest** restores it.
- Diffs use a compact file header (`path`, `+N -M`, Copy) and per-line add/del coloring with horizontal overflow.
- Streaming assistant Markdown on GPUix commits at most every 80ms instead of skipping formatting until the turn settles. Hydrated image previews still drop in-memory base64 after the preview file exists, and the renderer falls back to a data URL if that file is missing.
- Web rows use `content-visibility: auto`. Follow-tail no longer schedules a React state update when the sticky flag did not change.

## Host-backed checks

These used `scripts/validation/host-transcript-fixture.ts` on loopback, not `HEEDLEWORK_UI_FIXTURE`. The host served two persisted threads (~80+ messages, one with a three-tool work trace). Device: `hw-iphone` iOS 27 simulator `E83D7471-285E-4625-B84D-153BAC9815D3`.

| Check | Result |
| --- | --- |
| Bun `tests/host-transcript-live.test.ts` | passed: latest page, unique row ids, load-earlier keeps the tail, session switch, reconnect |
| Debug XCUITest `testHostTranscriptOpensAtLatestAndSwitchesSessions` | passed in 14.3s. Transcript list at 3.4s. `LATEST_ALPHA_ANSWER` at 5.7s. Worked-for header present. Switch to Beta showed `LATEST_BETA_ANSWER` at 13.9s. |
| Release XCUITest, same host | passed in 19.1s. Host was already on Beta from the Debug run; latest Beta reply was on screen, then switch to Alpha showed **Worked for 4s**, `src/ui/transcript.tsx`, and `LATEST_ALPHA_ANSWER` above the composer. Release needed `ENABLE_TESTABILITY=YES` so unit-test targets still compile. |
| iOS unit tests | 29 passed |
| Fixture XCUITest `testFixtureTranscriptGroupsWorkAndOpensAtLatest` | passed in 13.6s (Debug) |

Release vs Debug time-to-visible latest is the same order of magnitude (~5–6s from process start, including app launch). XCUITest wall time is not Core Animation FPS.

## Other measurements

These are CPU / test-renderer numbers, not frame times.

| Check | Result |
| --- | --- |
| 200-turn JS `groupWorkItems` + `projectTranscriptRows` | 0.37ms (`tests/transcript-projection-fixtures.test.ts`) |
| 2_000 streaming tokens through markdown cadence | fewer than 80 markdown commits (`tests/streaming-markdown.test.ts`) |
| GPUix 120-turn pagination suite | 28 passed, including follow-tail until the reader scrolls away |
| Typecheck | `bun run typecheck` and `bun run typecheck:web` |
| Web build | `bun run build:web` wrote `dist/web` |

Projection fixtures now cover collapsed work, live boundary, intermediate assistants, compaction, grouped notices, tool-only, thinking-only, error tools, abort status, and stream-to-history handoff. Row ids are unique in every case.

## Captures

- iPhone grouped fixture: `packaging/ios/screenshots/ios-ui/fixture-grouped-transcript.png`
- iPhone expanded work: `packaging/ios/screenshots/ios-ui/fixture-expanded-work.png`
- iPhone line diff: `packaging/ios/screenshots/ios-ui/fixture-diff-lines.png`
- Host Alpha after switch: `packaging/ios/screenshots/ios-ui/host-beta-latest.png` (Release run ended on Alpha: Worked for 4s, latest answer above composer)
- Host Beta: `packaging/ios/screenshots/ios-ui/host-alpha-latest.png` on the Release pass, because the host stayed on Beta from the earlier Debug switch

## Limits

- No Instruments FPS or hitch recording. Debug and Release XCUITest times include launch and accessibility snapshots.
- GPUix now windows React children (`itemCount` / `windowStart`, 160 rows) and reuses unchanged row objects. Off-window heights are estimates, so history prepend can shift a few pixels until measured. Streaming Markdown is still throttled at 80ms.
- Live token streaming and reconnect were dogfooded on the Bun host client. iOS reconnect was not forced; the host-backed UI test covers connect, load-earlier, and session switch over the real websocket.
- Scroll work-count budgets live in `docs/validation/scroll-performance.md`.
