# Scroll and streaming performance

This pass bounds React/DOM work on long transcripts. It does not claim 60 fps on every machine.

## What changed

- GPUix transcripts and the sidebar now pass `itemCount` / `windowStart` and only mount a slice of React children (`320` transcript rows, `80` sidebar rows).
- Unchanged projection rows keep their object identity so memoized row views skip work while a live assistant grows.
- Streaming markdown still commits at most every 80ms.
- Live-only controller fields (`liveAssistant`, `liveTools`, `activity`) notify listeners on a 16ms trailing timer. Session, message, and streaming flag changes still notify immediately.
- Web transcripts render an 80-row window with spacers. `content-visibility: auto` remains on rows.
- iOS still uses `LazyVStack`. Row views are `Equatable`, and projection rows are reused when the snapshot key is unchanged.

## Guardrails

These are work-count and identity checks, not hitch recordings.

| Check | Command | Budget |
| --- | --- | --- |
| Window math, prepend shift, row reuse | `bun test tests/virtual-window.test.ts` | 1000-turn web window = 80 rows |
| Live notify coalescing | `bun test tests/notify-batch.test.ts` | 3 trailing calls → 1 emit |
| Native 400-turn transcript window | `bun test tests/transcript-window-ui.test.tsx` | children ≤ 328, tail painted |
| Native 256-tool trace | `bun test tests/transcript-pagination.test.tsx` | continuation drains; mounted tools stay bounded |
| Web 400-turn DOM window | `bun test tests/web-transcript-window.test.ts` | row markup ≤ 80 |
| Sidebar 400 threads | `bun test tests/sidebar-scroll.test.tsx` | children ≤ 84 |
| CPU sample (not FPS) | `bun run benchmark:transcript` | print-only |

`bun run check` runs the TypeScript tests above.

## How to measure frames

There is still no Instruments hitch recording in CI. To measure scroll FPS locally:

1. Build a Release GPUix binary (`bun run build`).
2. Open a synthetic 200-turn and 1000-turn session.
3. Scroll idle, then stream a long reply, then switch sessions.
4. Use Instruments Core Animation or a browser performance trace on `dist/web`.

XCUITest wall time includes app launch. Projection milliseconds are CPU, not frames.

## Limits

- Off-window native rows use `estimatedItemHeight` (88px). Loading older history can shift a few pixels until those rows are measured.
- Host patches are coalesced only when the controller emits. The last live token can wait up to 16ms; the settled transcript still flushes immediately.
- iOS `LazyVStack` virtualizes views, not JSON decoding. Large snapshots still decode on the wire-engine flush (16ms).
- Sleep prevention still subscribes to controller notifies. Batching reduces reconcile churn; acquire/release behavior is unchanged.
