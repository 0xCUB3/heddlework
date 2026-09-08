# Heddlework responsiveness audit

Audited September 8, 2026, against `d55e9ad` plus the existing working tree. Measurements: Apple M4 Pro, macOS arm64, Bun 1.4.0. This change adds audit harnesses and this report, not production fixes or an installed build.

## Verdict

There is enough avoidable application work to explain sluggishness without blaming GPUix or the user's Pi extensions alone. The strongest finding is a broken memoization boundary: a process-local experiment stabilizing one transcript dependency reduced median native streaming commit time from 33.29 ms to 10.51 ms in the 160-turn rich-text fixture. That is about 68% less time in this harness, not a measured display-FPS improvement.

The other urgent issue is payload design. We virtualize rows but still read, serialize, transfer, and decode large invisible tool results. A normal-sized page can exceed the wire limit. A framework migration would preserve much of this cost.

## Scope and acceptance ledger

| Area | Audit evidence |
| --- | --- |
| Desktop launch and runtime attachment | Traced `main.tsx` through runtime discovery/staging, client welcome, and window creation |
| Saved-chat opening and Pi activation | Traced host preview, session bundle creation, controller bootstrap, and reverse history pager; existing navigation tests executed |
| Native transcript mount, scrolling, streaming | Offscreen GPUix probes with plain/rich transcripts; latest-message paint asserted in every fixture |
| Memoization and callback identity | Controlled benchmark-only module override, with production files unchanged |
| History and session catalog scaling | Synthetic disk fixtures, including large tool results and hidden records; no personal sessions read |
| Host protocol and desktop/web decode | Encode/assemble/parse probes, cumulative patch accounting, wire-cap rejection reproduced |
| Web scroll implementation | Source inspection plus DOM wheel regression; no browser frame trace |
| iOS decode, projection, and scrolling | Source inspection of wire actor, JSON conversion, projection cache, and SwiftUI list; no device timing |
| Terminal, browser, diff, persistence, session lifetime | Source inspection and existing terminal CPU/identity benchmark |
| Safety and verification | Both TypeScript checks passed; 75 focused tests passed, 0 failed, 517 assertions |

No live Pi sessions were switched or restarted, no model requests were issued, and no app was foregrounded. The process snapshot showed a background Heddlework runtime but no Heddlework desktop UI. These measurements therefore do not establish the running installed app's exact bottleneck. Linux, Windows, real trackpad input-to-present timing, concurrent CEF/terminal/chat workloads, and the user's full Pi-extension startup cost were not measured. Source findings below are distinguished from measured costs.

## Measurements

### Native rendering

`bun scripts/benchmark-responsiveness-native.tsx`

Each case uses a 900×640 offscreen native test window, 20 streaming updates, and 100 synthetic wheel/flush operations. Rich answers contain headings, links, lists, inline code, and fenced code. Stable callback props isolate Transcript from parent churn. Streaming measurements cover the immediate synchronous render/flush, not later throttled markdown effects.

| Fixture | Mount ms | Streaming median / p95 ms | Wheel+flush median / p95 / max ms |
| --- | ---: | ---: | ---: |
| 40 turns, plain | 31.72 | 20.31 / 24.42 | 3.34 / 6.39 / 14.99 |
| 160 turns, plain | 34.35 | 29.90 / 36.87 | 2.60 / 5.19 / 16.84 |
| 1,000 turns, plain | 27.22 | 33.95 / 40.27 | 4.00 / 5.63 / 20.78 |
| 40 turns, rich | 25.95 | 21.33 / 26.99 | 3.89 / 6.00 / 20.74 |
| 160 turns, rich | 27.14 | 33.29 / 37.88 | 4.89 / 8.92 / 21.50 |

The retained window was 81 rows for 40 turns and 320 rows for the larger fixtures. Mount times include differing initialization/cache conditions, so their ordering is not a scaling result. Unrelated editor-state updates were much cheaper: median 1.29–2.12 ms. The transcript's existing custom memo comparator does help; it is not accurate to say every state change rebuilds chat.

### Causal memoization experiment

`bun scripts/benchmark-responsiveness-native.tsx --stable-trace-lengths`

This flag uses a guarded Bun module-load override, not an edit to `src/ui/transcript.tsx`. It retains the trace-length map when its values are unchanged.

| Fixture | Production streaming median ms | Experiment median / p95 ms |
| --- | ---: | ---: |
| 40 turns, plain | 20.31 | 5.98 / 9.32 |
| 160 turns, plain | 29.90 | 8.40 / 13.65 |
| 1,000 turns, plain | 33.95 | 9.59 / 15.08 |
| 40 turns, rich | 21.33 | 6.82 / 8.51 |
| 160 turns, rich | 33.29 | 10.51 / 13.81 |

This is strong causal evidence for callback-induced row work during text streaming. It does not establish the improvement during changing tool-trace structure, nor does it make the whole app a 120 Hz UI. Even the improved commit consumes much of, or more than, an 8.33 ms frame budget.

### History, wire, and catalog

`bun scripts/benchmark-responsiveness.ts`

Three repetitions unless marked cold catalog. Disk repetitions share the OS file cache. History page timings include JSON serialization to count the resulting payload. Timer lag is a coarse event-loop probe, not a frame measurement.

| Probe | Result |
| --- | --- |
| 80 results × 1 KiB | 0.60 ms median; 0.09 MiB payload |
| 80 results × 128 KiB | 18.72 ms; 10.01 MiB payload |
| 80 results × 512 KiB | 74.79 ms; 40.01 MiB payload |
| Read through one hidden 1 / 4 / 16 MiB record | 2.54 / 21.99 / 216.03 ms median |
| 200 assistant updates, each adding 1 KiB | 200 KiB new text becomes 19.65 MiB of serialized patches, about 100.6× amplification |
| Wire encode/assemble/parse, 80 × 160 KiB results | 12.51 MiB, 51 frames, 17.59 ms median |
| Same wire probe, 240 × 160 KiB results | 37.52 MiB, 151 frames; rejected by the 32 MiB assembled cap; 50.57 ms median through rejection |
| Project 80 / 240 collapsed results of 160 KiB each | 0.23 / 0.25 ms median, one projected row |
| Catalog 100 / 1,000 / 5,000 files, cold, return 31 | 14.49 / 25.16 / 85.12 ms |
| Same catalog, warm in-memory summary cache | 11.42 / 13.55 / 23.85 ms median |

The 17.59 ms wire measurement combines host encoding and client assembly/parsing in one process without network latency. It must not be reported as 17.59 ms of client-only blocking. The 240-message case measures rejection, not successful decoding.

The existing tiny-text transcript CPU benchmark took 0.57 ms for 1,000 turns. Projection alone is not the leading measured expense. Collapsing a huge tool result makes projection cheap but leaves transport and parsing expensive.

## Ranked findings and remedies

### P0: Fix the confirmed streaming invalidation

`src/ui/transcript.tsx:162–168, 319–329, 367–392, 552–574`

A live update creates new `items`, then a new `traceLengths` map. `toggleTrace` depends on that map and changes identity. Every mounted row receives it, and every row's memo comparator compares it, including ordinary historical text rows that have no trace to toggle. Row object reuse cannot rescue that boundary.

Preserve semantic map identity and/or give the event handler stable identity with fresh data. Make row dependencies specific to row kind instead of giving all rows queue, widget, trace, and activity dependencies. Add a behavioral regression that counts historical row renders during live text and tool updates, not just mounted child count. Preserve fresh callbacks and disclosure correctness.

### P0: Bound bytes and defer invisible detail

`src/pi/session-history.ts:5–8, 51–115`; `src/host/server-runtime.ts:21–68`; `src/protocol/snapshot.ts:31–54`; `src/protocol/frames.ts:1–3`

The initial preview is 80 messages; the socket starts with 240; navigation can collect 1,200 to find conversational material. None is a byte budget. The socket anchor also retains everything added after it, so 240 is an initial window, not a permanent cap. `serializeSnapshot` bounds composer images, not transcript images or tool details.

Introduce a lightweight transcript projection for navigation, with strict byte/work budgets and separately retrievable full bodies. Keep complete authoritative history on the host. Carry stable entry IDs, branch identity, and explicit detail references; do not silently discard outputs. Reserve bounded space for the last prompt and answer so a page does not consist entirely of collapsed tools. Apply budgets before reading/materializing large values, not just before socket send.

### P0: Send incremental live content across the host boundary

`src/protocol/snapshot.ts:39–54`; `src/host/server.ts:215–237, 436–450`; `src/web/client.ts:126–149`

The Pi live bridge has delta work, but the workspace protocol replaces the entire `liveAssistant` field whenever its identity changes. The measured 100.6× amplification occurs downstream of Pi and affects the native desktop too: desktop attaches through `WorkspaceClient`.

Use versioned append/replace operations for live blocks and tool output, with sequence checks and a bounded resync snapshot. Preserve reconnect, compaction, branch changes, and tombstones. Encode a session update once for compatible subscribers, rather than independently serializing it per socket. Add backpressure/coalescing based on queued bytes, not only microtask scheduling.

### P1: Show the shell and selected thread before backend readiness

`src/main.tsx:75–82, 143, 253`; `src/runtime/bootstrap.ts:34–72, 121–150`; `src/client/runtime-attach.ts:49–81, 117`; `src/dom/remote-controller.ts:110–112`

The window is created after runtime discovery/staging, client welcome, and remembered-host selection. Runtime staging synchronously reads/hashes the executable and web resources even before deciding an existing runtime can be reused. Source launches can compile a runtime in this path. A stalled remembered remote host can add a connection timeout before the window exists.

Create the shell first. Restore cached sidebar/thread chrome immediately; show connecting state without blocking navigation. Local selection feedback should not wait for a host round trip. Load cached visible rows first, revalidate in the background, and expose Pi readiness separately from transcript readability. Do not accept mutating commands into the wrong session while activation is pending.

### P1: Reading a historical thread should not require a new heavy Pi process

`src/host/server-runtime.ts:327–365`; `src/host/session-runtime.ts:195–219, 278–287`; `src/host/runtime-composition.ts:37–65`; `src/pi/rpc-transport.ts:59–98`

Opening a thread without a bundle starts one even when the user only wants to read it. Bundles are retained until runtime disposal; there is no idle eviction policy in this path. A user browsing many threads can therefore accumulate Pi processes, plugin state, watchers, and controllers. Attaching to an already-live owner is correctly preferred over spawning a second writer.

Separate read-only history handles from execution leases. Start/attach execution on intent to act, or deliberate bounded prewarming. Evict only idle, unowned execution resources, preserving queued/running work and externally owned TUIs. Never solve this by disabling the user's extensions globally. Title generation already opts out of extensions, skills, and prompt templates; it is not another full-extension startup in this source.

### P1: Stop reverse scanning from repeatedly copying giant records

`src/pi/session-history.ts:89–111`

Each 256 KiB read concatenates the new chunk with the entire unfinished suffix, then scans that suffix again. A long JSON line is repeatedly copied and rescanned, giving superlinear cost. The 16 MiB hidden-record fixture took 216 ms even though it yielded only two visible messages.

Use a reverse newline index/chunk strategy that scans each byte once and joins each completed record once. A durable entry-offset/parent index would also let previews skip hidden payloads and follow old branches without scanning their abandoned tails. Preserve branch semantics and incomplete-write handling.

### P1: Keep optional metadata out of transcript readiness

`src/workbench/controller.ts:1598–1659, 1683–1717`; `src/pi/live-bridge.ts:520`

Bootstrap awaits both state and the session tree before loading its authoritative transcript. Refresh waits for the tree and fork messages. The live bridge's tree response contains `sessionManager.getTree()`, not just the leaf identifier. Previewing helps, but full-tree work still competes with the useful path and activation.

Expose a lightweight authoritative leaf/revision operation. Fetch the full tree only when opening tree navigation; fetch fork affordances independently. Retain the existing generation and branch-change safeguards. Actual full-extension readiness time was not measured here.

### P1: Reduce main-thread decode and image hydration

`src/protocol/frames.ts:75–85`; `src/protocol/messages.ts`; `src/web/client.ts:126–149`; `src/ui/clipboard-media.ts:86–123, 190–199`

Unframed messages are parsed once to detect frames and again as server messages. Desktop and browser process these on their UI-side JS thread. Transcript image hydration runs inside render-time memoization and decodes base64, hashes bytes, and synchronously checks/writes previews across loaded messages. Fresh messages arrays repeat work even when the image content is unchanged.

Parse once; move large decode/projection work off the interaction thread. Cache image hydration by stable content/entry identity and prepare visible thumbnails asynchronously. Keep full images out of routine state patches.

### P1: Make scrolling independent of expensive row and geometry work

`src/ui/virtual-window.ts:1–6`; `src/ui/virtual-list.tsx:53–94`; `src/dom/virtual-list.tsx:64–137`; `src/ui/motion.ts`

The actual shared web workbench uses `Transcript` through the DOM shim, so it inherits the 320-row transcript window. The older standalone 80-row web-window helper and its benchmark do not describe that whole production path. DOM range reporting reads every mounted child's geometry on wheel/scroll and after each layout; estimated spacers have no durable measured-height index. One huge markdown message is still one large row. Animation timers and layout-height transitions add work during activity changes.

Use a viewport-sized adaptive overscan window, stable measured heights, frame-coalesced range reporting, and block-level virtualization for giant messages. Preserve the user's reading anchor through prepend, resize, and streaming. Avoid height animation on the critical reading path; do not merely shorten an animation over a blocking task. Validate native scroll dispatch separately from React window shifts and actual presentation.

### P2: Avoid global catalog scans for each active-file change

`src/pi/session-catalog.ts:92–119, 190–218`; `src/pi/session-watch.ts:15–22`

The shared scan/cache is useful, but listing 31 entries still enumerates/stats the complete catalog. Watch notifications discard the changed path and can initiate refreshes every 150 ms under sustained traffic. Every retained controller also consumes shared catalog updates. The warm 5,000-file fixture still cost 23.85 ms per scan.

Track dirty paths, update a persistent sorted metadata index incrementally, and paginate without rescanning everything. Preserve shared in-flight scans and stable summary identities. This is background I/O cost, not evidence of a 24 ms UI-thread stall.

### P2: iOS avoids some blocking but still rebuilds too much

`packaging/ios/Heddlework/WorkspaceClient.swift:284–375`; `Protocol/JSONValue.swift:83–86`; `TranscriptViews.swift:22–35, 43–65`

Wire handling is already actor-isolated, not simply JSON decoding on the main actor. However, each coalesced patch converts the entire raw snapshot back through JSON serialization and typed decoding. SwiftUI then projects the loaded transcript on view-side refresh. `LazyVStack` does not make either operation incremental. The projection key uses message count, final live-block text length, and tool IDs/statuses rather than complete content revisions, which also risks stale equal-length changes.

Apply typed incremental patches, preserve stable message/row identities, publish ready viewport projections, and use explicit content revisions rather than lossy cache keys. Verify on-device anchor stability and hitches; no iOS speedup is claimed by this audit.

### P2: Budget secondary work instead of letting it compete freely

`src/workspace/git-diff.ts:8–47`; `src/receipts/recorder.ts:36–77`; `src/receipts/store.ts:48`; `src/ui/terminal-view.tsx:35–45`; `patches/gpuix-0.7.0-heddlework.patch`

Diff loading captures complete Git output before checking its 1.5 MB render limit and reads untracked contents for line counts. Receipts load before/after diffs and synchronously persist their document. These deserve shared diff jobs, early output limits, and scheduled persistence that preserves durability.

Terminal rendering already bypasses React frame subscriptions when the direct native path exists. The existing CPU probe passed: 522 KiB frame coalescing 0.15 ms, 2,000 incremental snapshots 15.52 ms, 98% row identity reuse. A single 5 MiB ANSI parse took 98 ms; large producer bursts still need a work budget. The browser shares the native event-loop/pump machinery and uses a native child view. Neither this source inspection nor the isolated terminal probe establishes browser-open chat performance; capture that combination before blaming CEF or claiming it is harmless.

## What “instant” should mean

These are proposed acceptance targets, not current guarantees:

- Selection/keypress acknowledgment on the next frame, ideally within 16 ms and never hidden behind Pi readiness.
- Warm thread switch to readable cached content within 100 ms p95 on the reference Mac; uncached local preview within 200 ms p95 for byte-bounded fixtures.
- No routine UI-thread task over 8 ms while targeting 120 Hz. Measure input-to-present and missed frames, not synthetic event throughput alone.
- Streaming updates proportional to the new data and changed rows, with bounded queued bytes and a separate resync budget.
- Stable reading position while streaming, loading earlier history, opening tools, and changing window width.
- Unvisited/offscreen bodies are neither decoded nor formatted until needed. Bounded read-only caches and execution leases prevent browsing from growing memory/process count indefinitely.

Prioritize the measured memoization failure, payload bounds, and live deltas first; then shell-first navigation and read-only history. Reconsider GPUix only after the same real workload still misses the presentation budget with those costs removed.

## Reproduce and verify

```sh
bun scripts/benchmark-responsiveness.ts
bun scripts/benchmark-responsiveness-native.tsx
bun scripts/benchmark-responsiveness-native.tsx --stable-trace-lengths
bun scripts/benchmark-transcript.ts
bun scripts/benchmark-terminal.ts
bun run typecheck
bun run typecheck:web
bun test tests/session-history.test.ts tests/session-history-controller.test.ts tests/session-switch.test.ts tests/host-transcript-window.test.ts tests/host-session-runtime.test.ts tests/session-runtime-lifecycle.test.ts tests/protocol-frames.test.ts tests/notify-batch.test.ts tests/runtime-attach.test.ts tests/dom-virtual-list-wheel.test.tsx tests/transcript-window-ui.test.tsx tests/transcript-pagination.test.tsx
```

The scripts use disposable synthetic files and offscreen windows. They print measurements rather than enforcing machine-dependent timing thresholds. The native experiment is deliberately explicit and guarded against source drift. Existing tests cover navigation safety and bounded retained work; neither their passing status nor a build would establish the latency targets above.
