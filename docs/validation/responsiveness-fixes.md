# Responsiveness fixes — acceptance ledger

Working against `d55e9ad` plus the pre-existing tree (README, install/deploy scripts, AGENTS, audit harnesses). This file maps every finding in `docs/validation/responsiveness-audit.md` to production changes. The audit stays the historical baseline; numbers below are from this Mac after the second integration pass, then packaging/install.

Pre-existing files that must remain: `README.md`, `AGENTS.md`, `scripts/install-dev.ts`, `scripts/deploy-dev.ts`, `scripts/dev-runtime.ts`, `scripts/install-dev-remote.sh`, `scripts/benchmark-responsiveness.ts`, `scripts/benchmark-responsiveness-native.tsx`, `tests/dev-deploy.test.ts`, `docs/validation/responsiveness-audit.md`.

## Finding 1 — P0 streaming invalidation / row-specific memo

**Requirement:** Stable transcript event dependencies and row-specific memo props. Historical row render counts must not rise during live text and tool updates that do not change those rows. Preserve fresh callbacks and disclosure correctness.

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/ui/transcript.tsx`, `src/ui/virtual-window.ts`, `src/ui/virtual-list.tsx` |
| Tests | `tests/transcript-window-ui.test.tsx`, `tests/transcript-pagination.test.tsx`, `tests/virtual-window.test.ts` |
| Before | native 160-turn rich streaming median 33.29 ms (audit); callback experiment 10.51 ms with a guarded module override |
| After | native 160-turn rich **5.82 ms** median / 9.75 p95; 1000-turn plain streaming **10.91 ms**; unrelated 1000-turn **3.31 ms**. Mounted rows **16** on the 640×900 offscreen fixture (viewport-sized, not a 160-row floor). |
| Proof | App still passes fresh `onRevert` / `onOpenDiff` / `onDismissNotice`; Transcript keeps wrapper identity via refs. The 160-row floor is gone: `adaptiveWindowSize(640, 88)` is the visible+overscan count. Short lists that fit in two viewports still mount in full so a 24-message thread can scroll. Giant markdown splits are cached and skipped for off-tail history. |

Limits: this is offscreen GPUix render/flush, not input-to-present or display FPS. Native `estimatedItemHeight` is still 88 px until a row is measured; window size uses the measured average when heights exist.

## Finding 2 — P0 bound bytes and deferred detail

**Requirement:** Bounded byte/work-budget history and wire projection, with on-demand complete detail retrieval through host, native/shared web UI, and iOS. No lost authoritative data. Branch-safe stable IDs. Last prompt/answer reserved. Budgets applied before materializing large values.

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/protocol/transcript.ts`, `src/protocol/commands.ts`, `src/protocol/frames.ts`, `src/host/server-runtime.ts`, `src/workbench/controller.ts`, `src/dom/remote-controller.ts`, `src/web/client.ts`, `src/ui/transcript.tsx`, iOS `WorkspaceClient.swift`, `WorkspaceModels.swift`, `WorkspaceProtocol.swift` |
| Tests | `tests/protocol-transcript-detail.test.ts` (including **>32 MiB** JSON roundtrip), `tests/protocol-transcript-projection.test.ts`; iOS `testGetTranscriptDetailCommandShape`, typed merge |
| Before | `pageTranscriptDetail` flattened structured bodies to `text` and `mergeMessagePage` replaced `content` with that string, dropping images, tool-call blocks, and args. 80×512 KiB page 74.79 ms / 40.01 MiB. |
| After | Detail pages are UTF-8 slices of `JSON.stringify` of the original `PiMessage` / `ToolRun` / `LiveAssistant`. Default page **512 KiB**, clamped, progress at unicode boundaries even when `limit` is 1. History 80×512 KiB **0.01 MiB** median **41.5 ms**. 16 MiB hidden record **16.4 ms**. 2 MiB `arguments.cmd` still stubs under 1.5 MiB. >32 MiB body reassembled equal to the original. |
| Proof | `encoding: 'json'` plus optional `message`/`tool`/`assistant` only when the whole object fits in the page. `TranscriptExpansionCache` overlays expanded bodies so a later stubbed snapshot does not immediately re-collapse them. Session/revision/request identity drops duplicate, out-of-order, and switched-session pages. Remote walks at most 256 pages. |

Limits: one command result is still a page, never a 32 MiB blob. Full recovery is the concatenation of pages. Anonymous `anon:` ids are not lookup keys.

## Finding 3 — P0 incremental live content

**Requirement:** Versioned incremental assistant/tool updates, sequencing/reconnect/resync correctness, bounded buffers/backpressure, encode a session update once rather than per socket.

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/protocol/snapshot.ts`, `src/protocol/transcript.ts`, `src/workbench/state.ts`, iOS `JSONValue.swift`, `WorkspaceModels.swift`; production bench `scripts/benchmark-responsiveness.ts` |
| Tests | `tests/protocol-live-delta.test.ts`; `tests/protocol-transcript-detail.test.ts` projected live; iOS `testTrimLiveOpDropsPrefixBytes`, `testTypedLivePatchDoesNotRebuildUnchangedMessages` |
| Before | 200 × 1 KiB assistant updates → 19.65 MiB (~100.6×) on unprojected replace. After a 64 KiB tail window, `startsWith` failed and the host resent the moving tail every token. |
| After | Production probe is **projectWorkbenchSnapshot + diffSnapshots + applySnapshotPatch**. 200 KiB new text → **0.23 MiB, 1.2×**. Retained projected tail **65536** bytes. `findTranscriptDetail` on the unprojected live body recovers the full original (`recovered: true`). Sliding windows emit `trim` + `append`, not a full tail replace. |
| Proof | Live blocks carry `textOffset` + `detailRef` (`id#index`). Live tools carry `outputOffset` + `detailRef`. Aggregate live tool stubs stay under the **1.5 MiB** wire budget (400 × 32 KiB outputs projected). Seq-gap reconnect still resyncs per target. Expansion cache applies appends and ignores trims so an expanded live body does not lose prefix. |

## Finding 4 — P1 shell-first runtime attach

**Requirement:** Shell-first runtime attach and immediate safe navigation/cached readable previews.

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/main.tsx`, `src/client/runtime-attach.ts` (kept) |
| Tests | `tests/runtime-attach.test.ts` |
| Before | window created after runtime discovery/staging/welcome; connecting click discarded on `adopt` |
| After | Shell paints connecting chrome first. `ShellWorkbenchController` stores pending `switchSession` / editor text and replays them on `adopt`. |
| Proof | reuse-without-hash still passes. Click-during-connecting is not dropped on adopt. |

## Finding 5 — P1 read-only browsing and execution leases

**Requirement:** Read-only thread browsing without spawning Pi. Bounded execution leases. Preview commands must not silently default-attach.

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/host/session-runtime.ts`, `src/host/server-runtime.ts`, `src/host/server.ts` |
| Tests | `tests/session-runtime-lifecycle.test.ts`, `tests/host-transcript-window.test.ts` no-retarget |
| Before | `socketAttachment` called `runtime.attach()` for preview sockets, which touched the default live session. Idle sweep ignored connected sockets. Preview `loadEarlier` hit 1200 messages and stuck with `hasOlder` true. |
| After | Preview sockets set `leased: false` and never call `attach()`. No-lease commands either run against the selected session (presence, catalog, pin, composer images, history) or start a lease on intent (submit/queue/rename) or return `… is not available without an execution lease`. Idle sweep skips running/queued/attached **and** sessions with a socket refcount. Preview earlier-history slides the 1200-message window instead of getting stuck. Concurrent `loadEarlier` is serialized per socket. |
| Proof | Preview `sessionKey` stays on the historical path with `leased: false`. Lifecycle test still protects running/queued/attached. |

## Finding 6 — P1 linear reverse history scanner

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/pi/session-history.ts`, `src/pi/session-history-scan.ts` |
| Tests | `tests/session-history.test.ts` |
| Before | 16 MiB hidden-record fixture 216.03 ms |
| After | **16.4 ms** median in `benchmark-responsiveness.ts` |
| Proof | Pagers serialize on one queue. Preview without a leaf id starts on the last **visible** record. |

## Finding 7 — P1 lightweight leaf/revision readiness

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/pi/live-bridge.ts`, `src/workbench/controller.ts` |
| Tests | `tests/session-open-latency.test.ts` |
| Before | bootstrap awaits full session tree; `get_leaf` miss returned undefined |
| After | `get_leaf` failure falls back to `get_tree` for leaf id only |
| Proof | open-latency test still asserts no `get_tree` on the happy path. |

## Finding 8 — P1 parse once and async image hydration

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/protocol/frames.ts`, `src/web/client.ts`, `src/ui/clipboard-media.ts`, `src/ui/image-hydration-worker.ts`, `src/ui/transcript.tsx`, `scripts/build.ts`, `scripts/probe-image-hydration.ts` |
| Tests | `tests/protocol-frames.test.ts`; `tests/image-hydration-cache.test.ts`; `tests/image-hydration-worker-packaging.test.ts`; `tests/web-build.test.ts` |
| Proof | Unframed `{"kind":"pong"}` is the object. `hydrateMessageImages(..., { eager: false })` is a no-op. Visible ids hydrate through `prepareVisibleMessageImages` on a Worker when available; the DOM shim does not import `node:worker_threads`. Fallback decode is async, not render-synchronous. Desktop `Bun.build({ compile })` lists `src/ui/image-hydration-worker.ts` as a second entrypoint. A compiled probe calling production `prepareVisibleMessageImages` on a 1×1 PNG, signed and run from an empty temp directory, reports `imageHydrationBackend() === 'worker'`, `compiled: true`, and preview bytes equal to the source PNG. |

Limits: if the Worker fails to start at runtime, base64 still runs on the JS thread after `Promise.resolve()`, not inside the memoized render path. That fallback is not packaging acceptance; the compiled probe requires the worker. Offscreen GPUix benches still are not input-to-present or display FPS.

## Finding 9 — P1 adaptive viewport and stable scroll anchors

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/ui/virtual-window.ts`, `src/ui/virtual-list.tsx`, `src/ui/transcript.tsx` |
| Tests | `tests/virtual-window.test.ts`, `tests/transcript-pagination.test.tsx`, `tests/dom-virtual-list-wheel.test.tsx` |
| Before | 160-row floor made `ceil(height/88)+overscan` inert on normal windows. |
| After | Native offscreen fixture mounts **16** rows. Prepend at the exact top shifts `windowStart` so the retained row stays in the viewport. Short threads that fit in two viewports mount fully. |
| Proof | `adaptiveWindowSize(640, 88, 6)` is less than 160. Web 1000-turn bench window **29 of 2000**. |

## Finding 10 — P2 incremental catalog refresh

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/pi/session-catalog.ts`, `src/pi/session-watch.ts` |
| Tests | `tests/session-catalog.test.ts` |
| Before | warm 5,000-file catalog 23.85 ms |
| After | warm 5,000-file **23.16 ms** median |
| Proof | Dirty-path restat/identity tests still cover create/delete/rename. |

## Finding 11 — P2 iOS typed incremental patches

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | iOS Protocol/*, WorkspaceClient, TranscriptViews |
| Tests | `HeddleworkTests` **63 passed / 0 failed** on booted `hw-iphone` via `xcodebuild test` (no Simulator.app). |
| Before | View reprojected the whole snapshot whenever any trace was expanded. Invalid `changed` payloads assigned `nil`. `mergeSnapshotJSON` was what some tests called. |
| After | Off-main `transcriptRows` stay the base; `expandCollapsedRows` inserts expanded entries locally. `applySnapshotChangedKey` keeps modeled fields when decode fails. `removed` clears real fields including `messages`. Trim liveOps apply through production `applySnapshotPatch`. Typed detail pages reassemble JSON, not flattened text. |
| Proof | `testInvalidChangedPayloadKeepsModeledFields`, `testPatchRemovedClearsOptionalWireKeys` (production apply), `testTrimLiveOpDropsPrefixBytes`, `testTypedLivePatchDoesNotRebuildUnchangedMessages`. |

## Finding 13 — Load full output was inert; reading is viewport hydration

**Requirement:** The production Load full output control must actually adopt host detail into the visible snapshot. Normal 10KB bodies hydrate from the viewport without a click. Collapsed work traces stay collapsed. Older history still pages at the top. Session switches cannot leave Opening thread over a blank or foreign transcript. Scroll stays on the display frame, not a 60Hz timer.

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/protocol/transcript.ts`, `src/workbench/controller.ts`, `src/host/server-runtime.ts`, `src/web/client.ts`, `src/dom/remote-controller.ts`, `src/ui/transcript.tsx`, `src/ui/virtual-window.ts`, iOS `WorkspaceClient.swift`, `TranscriptViews.swift` |
| Tests | `tests/transcript-detail-hydration.test.ts`, `tests/remote-session-navigation.test.ts`, `tests/transcript-window-ui.test.tsx`, `tests/protocol-transcript-detail.test.ts`, `tests/dom-virtual-list-wheel.test.tsx` |
| Root cause | App wrapper `onLoadDetail={(id) => controller.getTranscriptDetail(id).then(() => undefined)}` discards the page. Native controller never merged. Host `findTranscriptDetail` skipped omitted stubs and ignored `toolCallId`. Client merge could apply a page onto the wrong session. Collapsed `Worked` painted a Load pill that did not change any visible text. Switch preview could wipe cached messages and stay on Opening thread. |
| After | Cheap omitted assistant/user bodies and expanded tool outputs prefetch from the visible window (concurrency 2, in-flight dedupe, generation cancel). Bodies larger than 2 MiB stay opt-in so a 100MB JSON is not downloaded or parsed to paint the first screen. Overlay cache still survives a later stubbed patch. Remote navigation keeps the newest session file, ignores late foreign snapshots, and does not replace cached rows with an empty Opening patch. Failed switches leave Ready/error, not a stuck composer. Wheel reporting stays rAF-coalesced; the 16ms fallback is only when `requestAnimationFrame` is missing. |

Limits: offscreen GPUix commit timing is still not input-to-present or display FPS. Advertised Hz (`HEDDLEWORK_DISPLAY_HZ`) is not claimed achieved presentation. Preview sockets become `connected`/`Ready` once history settles so reading is not blocked on an execution lease; submit still starts a lease.

## Finding 12 — P2 budget secondary work

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/workspace/diff-job.ts`, `src/workspace/git-diff.ts`, `src/receipts/store.ts`, `src/receipts/plugin.ts`, `src/terminal/work-budget.ts`, `src/terminal/service.ts` |
| Tests | `tests/workspace-diff.test.ts`, `tests/receipt-store.test.ts`, `tests/terminal-work-budget.test.ts` |
| Before | `#drain` never rejected waiters on permanent write failure, so `dispose`/`flushed` could hang. Shared diff cancel aborted every subscriber. `writeVtBounded` could split UTF-8. Unused browser-contention helper is gone. |
| After | Receipts: bounded retry, permanent `EACCES` rejects `flushed` and `dispose`, timers cancelled, injected IO in tests, plugin dispose calls `store.dispose()`. Diff jobs refcount subscribers. VT writes yield on UTF-8/CSI boundaries and keep the remainder. Terminal bench: frame coalescing **0.13 ms**, 2,000 snapshots **13.50 ms**, 5 MiB parse **98.47 ms**, **98%** row identity. |
| Proof | Permanent unwritable path test; transient recovery after two failures; UTF-8 remainder test. Live CEF+chat contention was **not** measured (no foreground browser). |

## Finding 14 — live session catalog without a click

**Requirement:** External Pi JSONL activity must update native, web, and iOS sidebars without selecting a thread. Read-only browse, click, and `reportPresence` must not invent recency. Watchers stay one-per-root with cheap fallback.

| Field | Value |
| --- | --- |
| Status | **done** |
| Changed paths | `src/host/server.ts`, `src/pi/session-watch.ts`, `src/pi/session-catalog.ts`, `src/host/runtime-composition.ts`, `src/ui/sidebar.tsx`, `src/ui/sidebar-session-row.tsx`, `src/ui/session-order.ts`, `src/workbench/thread-lifecycle.ts` |
| Tests | `tests/session-catalog-publish.test.ts`, `tests/session-catalog.test.ts`, `tests/session-live-discovery.test.ts`, `tests/remote-session-navigation.test.ts`, `tests/sidebar-lifecycle.test.ts` |
| Root cause | Catalog refresh already ran on the default controller after `fs.watch`. Host `flushSession` only patched sockets whose `sessionKey` matched that controller. Read-only preview sockets (the normal browse path) kept a stale `sessions` list until `switchSession` copied the default snapshot, which is why the sidebar jumped on click. File mtime/size cache could skip in-place same-size updates. Fallback watches rescanned on every 5s retry. |
| After | `publishCatalog` fans `sessions` / `sessionsLoading` / `sessionsHasMore` to every socket without changing `sessionKey`, transcript, or lease. Dirty JSONL paths always re-read. Nested directory dirty paths restat that directory. Watcher recovers missing roots via the parent directory and only full-invalidates fallback when root identity/mtime changes. Recency sort ties break on path. Pointer-down freezes row order for the click. |
| Proof | Isolated temp Pi JSONL + real `fs.watch` + host websocket: sitting on a preview thread with `leased: false`, append/rename/create/delete published without a second click. Append→published **under 2 s** (debounce 150 ms); dirty restat delta **< 8**. `reportPresence` / switch did not change the other thread's `modifiedAt`. Catalog subscribe watches `getPiSessionRoot(agentDir)`, not the workspace home path. |

Limits: event→published is watcher debounce plus one incremental list, not display FPS. Network fallback is a root stat, not a per-file poll; appends that do not bump directory mtime can wait until the next native event or mtime change.

## Review corrections this pass

1. Typed full detail — **fixed**. JSON pages restore images, tool-call blocks, args, details, unicode. >32 MiB roundtrip passed.
2. Live silent truncation — **fixed**. `detailRef` on live tools and assistant blocks; UI Load-full-output reads both. Sliding `trim`/`append` after 64 KiB.
3. Production live bench used raw `diffSnapshots` — **fixed**. Harness now projects, diffs, applies, and checks recovery.
4. Receipt `#drain` hang — **fixed** with injected IO.
5. Preview `attach()` — **fixed**. `leased: false`, allowlist or explicit lease or error.
6. Idle sweep vs sockets — **fixed** with retain/release refcounts.
7. Preview earlier-history stuck at 1200 — **fixed** by sliding the window.
8. iOS expanded traces reprojected on-view — **fixed** with `expandCollapsedRows`.
9. Invalid Swift patches set nil — **fixed**.
10. 160-row floor — **removed**. Native fixture mounts 16 rows.
11. Packaged image worker — **fixed**. `new URL('./image-hydration-worker.ts', import.meta.url)` resolves against the compiled outfile in `/$bunfs/root` and never finds the extra entrypoint. Compile lists the worker file; the UI thread starts `./src/ui/image-hydration-worker.ts` when `import.meta` is under `/$bunfs/`.
12. Idle protocol-mismatch attach threw instead of using POST `/upgrade` — **fixed**. `attachOrStartRuntime` stages first, consults `/status`, and upgrades only when idle (409 defers). Installer `refresh: true` also replaces a same-protocol identity; app attach stays the no-hash warm path. No `/stop`, no `launchctl bootout` of a live runtime, no process kill.

## Verification log

- Root typecheck: pass. Web typecheck: pass. Repeated after the worker packaging change.
- Focused protocol/host/UI set: 107 pass / 0 fail (detail, live-delta, receipts, pagination, window-ui, virtual-window, host transcript/terminal, web client, lifecycle, attach, diff, VT budget).
- Full `bun test` on the implementation tree before packaging: **764 pass / 2 skip / 0 fail**, 5296 assertions, 159 files, 85.19s (Main). Packaging added `tests/image-hydration-worker-packaging.test.ts`; that file plus clipboard/virtual-window/web-build reruns: **18 pass / 0 fail** including the compiled worker probe (843 ms compile+run). `tests/virtual-window.test.ts` no longer has a blank line at EOF (`git diff --check` clean). After the idle-upgrade work: **772 pass / 2 skip / 0 fail**, 5332 assertions, 161 files, 84.53s. Targeted runtime/deploy tests 21 pass. Root and web typecheck pass.
- `bun scripts/benchmark-responsiveness.ts`: live **1.2× / 0.23 MiB / recovered true**; history 80×512 KiB **0.01 MiB / 41.5 ms**; 16 MiB hidden **16.4 ms**.
- `bun scripts/benchmark-transcript.ts`: 1,000-turn project 0.78 ms; web window 29/2000.
- `bun scripts/benchmark-terminal.ts`: numbers above.
- `bun scripts/benchmark-responsiveness-native.tsx`: offscreen GPUix, no FPS, no foreground. 160-turn rich stream **5.82 ms** median, **16** mounted rows, tail painted.
- iOS: **63 passed / 0 failed** on booted `hw-iphone` without Simulator.app.
- PROTOCOL_VERSION is **2**. No pairing tokens printed. No commits.
- `bun scripts/install-dev.ts --no-launch` exit 0 (second install after idle-upgrade). Both Macs have `Heddlework Dev.app` **0.1.4** (`io.github.monotykamary.heddlework.dev`), app sha256 prefix `a09496d220e3f51e`, bundled runtime sha256 prefix `41b919c44c7fdc47`. Staged runtime identity `f44b69d6e866f1fe5eae0ac8`; staged executable hash matches the bundle on both Macs. `Contents/MacOS` is only `Heddlework`. No GUI launch. No pairing tokens printed. No commits.
- Active background runtimes after idle `/upgrade`: local pid **64790** and remote pid **45130**, both protocol **2** / version 0.1.4 / `busy: false` / supervisor launchd. New instance ids (`b4c3e662…`, `8ba032e2…`); old pids 87412 and 64628 are gone. Loopback `/health` `{ ok: true, protocol: 2 }` and websocket `welcome` protocol 2 on both Macs. Previous install had left those protocol-1 processes running because attach threw on mismatch; `--no-launch` now reconciles an idle runtime through the authenticated upgrade API and defers honestly if busy.
- Detail hydration pass: root and web typecheck pass. Full `bun test` **783 pass / 2 skip / 0 fail**, 5371 assertions, 163 files, 86.56s. iOS `HeddleworkTests` **64 passed / 0 failed** on booted `hw-iphone` (added `testSameSessionFileAndToolCallIdentity`). Native offscreen GPUix 160-turn rich stream **4.82 ms** median / **9.08 p95**, mounted rows **16**, tail painted (prior **5.82 ms** / 16 rows). That is still commit/flush, not display FPS. Production host+client test adopts a 10KB toolResult through `RemoteWorkbenchController.getTranscriptDetail(id).then(() => undefined)`. Collapsed Worked no longer shows Load full output. Wheel bursts coalesce to the display frame.
- Catalog live-publish pass: root and web typecheck pass. Full `bun test` **791 pass / 2 skip / 0 fail**, 5397 assertions, 164 files, 84.88s. Host fixture with real `fs.watch` published append/rename/create/delete to a read-only preview socket without a click (`leased: false`); dirty restat delta &lt; 8. No Swift change. `bun scripts/install-dev.ts --no-launch` exit 0. Both Macs `Heddlework Dev.app` **0.1.4** (`io.github.monotykamary.heddlework.dev`), app sha256 prefix `a0a3643686fbc06c`, bundled runtime sha256 prefix `8de0b5a87834ed24`. `Contents/MacOS` is only `Heddlework`. Local pid **26400**, mbp2 pid **46454**, both protocol **2** / `busy: false` / supervisor launchd. Loopback `/health` `{ ok: true, protocol: 2 }` on both. No GUI launch. No pairing tokens printed. No commits.
