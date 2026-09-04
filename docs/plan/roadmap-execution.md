# Roadmap execution plan

This plan turns every README roadmap item except the Codex and Claude adapters into ordered, verifiable work. It is written so that an executor with no prior context can complete a phase from this file alone. Each phase lists the exact files, the contracts they must expose, the tests that prove them, and the command that decides done.

GPUIX stays the primary surface. Nothing in `src/ui/` loses functionality, and no phase replaces `@gpuix/react` rendering. Web and mobile are additional surfaces over the same controller, projections, and stores.

## Ground rules for every phase

1. Read the files named in the phase before editing. The plan describes intent; the code is truth.
2. One phase is one commit on `main` of `0xCUB3/heddlework`. Commit message follows conventional commits (`feat(host): ...`).
3. Run `bun run check` (typecheck plus `bun test`) before each commit. A phase is not done until it passes and its listed behavioral probes pass.
4. Every new registration, listener, timer, server, or process must have an inverse attached to the owning plugin via `ctx.effect(() => cleanup)` (Cordis temporal composability, see README).
5. Replaceable capabilities are `serviceToken`s in `src/workbench/plugins.ts` or a sibling plugin module, consumed through `requires`. Never locate providers globally.
6. No decorative comment dividers. Plain single-line comments only.
7. Pi stays authoritative for messages and sessions. New stores hold Heddlework-owned annotations only.
8. When a phase adds a public symbol, export it from `src/plugin-api.ts` and confirm with `grep`.
9. Update the README status table and roadmap checkbox for the phase in the same commit.

## Architecture summary (read before Phase 1)

- `src/core/kernel.ts`: `WorkbenchKernel`, `serviceToken`, `slotToken`, `PluginContext` with `provide/get/effect/contribute/on/emit`.
- `src/workbench/plugins.ts`: tokens `agentTransportToken`, `sessionCatalogToken`, `workspaceDiffToken`, `workbenchControllerToken` and the plugin factories that `src/main.tsx` mounts.
- `src/workbench/controller.ts`: `WorkbenchController` with `subscribe`, `getSnapshot(): WorkbenchState`, and the public command methods listed at lines 160 to 889 (submit, queueInput, abort, newSession, switchSession, setModel, setThinkingLevel, respondToDialog, settleThread, snoozeThread, refreshWorkspaceDiff, and so on).
- `src/workbench/state.ts`: `WorkbenchState`. Everything in it is plain data except `messages` (Pi message objects) which are JSON already.
- `src/pi/transport.ts`: `AgentTransport` (start, stop, request, send, onEvent, onStatus, getStderr). This is the harness seam.
- Renderer-neutral modules (no `@gpuix/react` import, safe to reuse in a browser bundle): `src/ui/transcript-projection.ts`, `src/ui/call-preview.ts`, `src/ui/duration.ts`, `src/ui/markdown-source.ts`, `src/ui/math-segment.ts`, `src/ui/theme.ts`, `src/flows/projection.ts`, `src/flows/fabric-projection.ts`, `src/workbench/queue.ts`, `src/workbench/timeline.ts`, `src/workbench/thread-lifecycle.ts`.
- Modules that import `node:` and must stay on the host side: `src/pi/*` (except `types.ts`, `slash-commands.ts`), `src/workspace/git-diff.ts`, `src/workbench/queue-store.ts`, `src/workbench/thread-metadata-store.ts`, `src/flows/runtime.ts`, `src/flows/types.ts` (uses `node:crypto` and `node:path`, see Phase 1 fix).
- Tests live in `tests/`, use `bun:test`, and build kernels the way `tests/plugin-composition.test.ts` does. `tests/fixtures/fake-pi.ts` is a scripted Pi process. `tests/helpers/workbench.ts` builds controller dependencies.
- Build: `scripts/build.ts` compiles `src/main.tsx` into `dist/heddlework` with `Bun.build({ compile })`. CI: `.github/workflows/check.yml` runs on `macos-latest` with Bun 1.4.0.

## Phase order and dependency graph

```
P1 protocol  -> P2 host server -> P3 web client -> P4 mobile PWA
P1 protocol  -> P5 plugin discovery
P1 protocol  -> P6 receipts/artifacts -> P7 dependency graph + checkout lanes
P2 host      -> P8 release CI (host is bundled into desktop binary)
```

P1 must land first. P5, P6 and P8 can be done in any order after P2. P3 before P4. P6 before P7.

---

## Phase 1: Stable harness adapter protocol and shared wire types

Goal. Freeze the application-facing contract so that a remote surface (web, mobile) and a future adapter both speak one versioned, JSON-serialisable protocol. The desktop keeps calling the controller in-process; the protocol is the same commands as plain data.

Files to create.

- `src/protocol/version.ts`: `export const PROTOCOL_VERSION = 1 as const`.
- `src/protocol/adapter.ts`: `HarnessAdapter` interface. It extends `AgentTransport` from `src/pi/transport.ts` with `readonly id: string`, `readonly displayName: string`, `readonly capabilities: HarnessCapabilities`. `HarnessCapabilities` is `{ sessions: boolean; sessionTree: boolean; queueMirror: boolean; models: boolean; thinking: boolean; compaction: boolean; extensionUi: boolean; fork: boolean; export: boolean }`. Add `export function describePiAdapter(): HarnessCapabilities` returning all true. Add `isHarnessAdapter(value: unknown): value is HarnessAdapter`.
- `src/protocol/commands.ts`: discriminated union `WorkbenchCommand` with one member per public controller method that a remote surface needs. Minimum set, each `{ type, ...args }`: `submit {text, queue?}`, `queueInput {text, lane?, paused?}`, `updateQueuedInput {id, text}`, `removeQueuedInput {id}`, `moveQueuedInput {id, targetIndex}`, `moveQueuedInputToLane {id, lane}`, `toggleQueuedInputPause {id}`, `steerQueuedInput {id}`, `resumeQueue`, `pause`, `abort`, `newSession`, `switchSession {path}`, `refreshSessions`, `loadMoreSessions`, `loadEarlierMessages`, `setModel {provider, id}`, `setThinkingLevel {level}`, `compact`, `respondToDialog {value?, confirmed?, cancelled?}`, `submitAskUserQuestionnaire {toolCallId, answers}`, `cancelAskUserQuestionnaire {toolCallId}`, `settleThread {path}`, `snoozeThread {path, snoozedUntil}`, `wakeThread {path}`, `setThreadPriority {path, priority}`, `setThreadLabels {path, labels}`, `markThreadRead {path, updatedAt}`, `refreshWorkspaceDiff`, `dismissNotice {id}`, `clearNotices`, `setEditorText {text}`. Export `export function applyWorkbenchCommand(controller: WorkbenchController, command: WorkbenchCommand): Promise<void>` that switches on `type` and calls the controller. `setModel` must look the model up in `controller.getSnapshot().models` by `provider` and `id` and throw `Unknown model` when absent.
- `src/protocol/snapshot.ts`: `export type WorkbenchSnapshot = WorkbenchState` plus `export function serializeSnapshot(state: WorkbenchState): WorkbenchSnapshot` that strips `editorImages[].data` bytes larger than 256 KiB into `{ omitted: true, bytes }` and leaves everything else. `export function diffSnapshots(previous, next): SnapshotPatch` where `SnapshotPatch = { version: 1; changed: Partial<WorkbenchSnapshot> }` containing only top-level keys whose reference changed. This is the wire unit for Phase 2.
- `src/protocol/messages.ts`: `ClientMessage = { kind: 'hello'; protocol: number } | { kind: 'command'; id: number; command: WorkbenchCommand } | { kind: 'ping' }` and `ServerMessage = { kind: 'welcome'; protocol: number; workspacePath: string; snapshot: WorkbenchSnapshot; flows: FlowRuntimeSnapshot } | { kind: 'patch'; patch: SnapshotPatch } | { kind: 'flows'; snapshot: FlowRuntimeSnapshot } | { kind: 'result'; id: number; ok: true } | { kind: 'result'; id: number; ok: false; error: string } | { kind: 'pong' }`.
- `src/protocol/index.ts` re-exporting the above.

Files to modify.

- `src/flows/types.ts`: replace `import { randomUUID } from 'node:crypto'` and `basename` from `node:path` with browser-safe equivalents. Use `globalThis.crypto.randomUUID()` (available in Bun and browsers) and a local `basenameOf(path)` helper that splits on `/` and `\\`. Verify with `grep -n 'node:' src/flows/types.ts` returning nothing.
- `src/workbench/state.ts`: check it has no `node:` import (it does not today, keep it that way).
- `src/plugin-api.ts`: export `HarnessAdapter`, `HarnessCapabilities`, `WorkbenchCommand`, `WorkbenchSnapshot`, `SnapshotPatch`, `ClientMessage`, `ServerMessage`, `PROTOCOL_VERSION`, `applyWorkbenchCommand`, `serializeSnapshot`, `diffSnapshots`.
- `src/pi/rpc-transport.ts` and `src/pi/demo-transport.ts`: implement `HarnessAdapter` (add `id`, `displayName`, `capabilities`). Keep `AgentTransport` as the structural base so existing tests do not change.
- `docs/harness-adapter-protocol.md`: describe the adapter interface, capabilities, the command union, the snapshot/patch model, and the authority rule (adapter owns transcripts, Heddlework projects them). Link it from the README architecture section.

Tests to add.

- `tests/protocol-commands.test.ts`: build a kernel with the demo transport exactly like `tests/plugin-composition.test.ts`, then for every `WorkbenchCommand.type` send one command through `applyWorkbenchCommand` and assert the snapshot changed as expected (at least: `setEditorText`, `submit`, `queueInput` while streaming, `abort`, `settleThread`, `setThinkingLevel`, `setModel` with unknown model rejects).
- `tests/protocol-snapshot.test.ts`: `diffSnapshots` returns only changed keys; `serializeSnapshot` round-trips through `JSON.parse(JSON.stringify())` with deep equality for a snapshot from the demo controller after one turn; a large image is replaced with `{ omitted: true }`.
- `tests/protocol-browser-safe.test.ts`: import `src/protocol/index.ts`, `src/flows/projection.ts`, `src/ui/transcript-projection.ts`, `src/workbench/queue.ts`, `src/flows/types.ts` and assert via `Bun.build({ entrypoints, target: 'browser', write: false })` that the bundle succeeds with no `node:` externals. This test is the guard that keeps the shared layer browser-safe for Phases 3 and 4.

Acceptance.

- `bun run check` passes.
- `grep -rn "node:" src/protocol src/flows/types.ts src/workbench/state.ts src/workbench/queue.ts` prints nothing.
- `grep -n "HarnessAdapter\|applyWorkbenchCommand" src/plugin-api.ts` shows both exports.
- README roadmap: check `Stable harness adapter protocol`.

---

## Phase 2: Workspace host server

Goal. Serve the Phase 1 protocol over WebSocket from inside the running desktop process, and also as a headless `bun run host` for remote hosts. This is what the web and mobile clients connect to.

Files to create.

- `src/host/server.ts`: `createWorkspaceHost(options: { controller: WorkbenchController; flows: FlowRuntime; workspacePath: string; port: number; hostname?: string; token: string; staticRoot?: string }): WorkspaceHost`. `WorkspaceHost = { url: string; port: number; close(): Promise<void> }`. Uses `Bun.serve` with `websocket` handlers. On upgrade, require `?token=` query or `Authorization: Bearer` to equal `options.token`; otherwise respond 401. On open, send `welcome`. Subscribe to `controller.subscribe` and `flows.subscribe`; on each change compute `diffSnapshots` against the last snapshot sent to that socket and send `patch` (skip when `changed` is empty). Coalesce with `queueMicrotask` so a burst of state changes yields one patch. On `command`, call `applyWorkbenchCommand` and reply with `result`. On `ping` reply `pong`. Serve `staticRoot` files for GET requests when provided (Phase 3 uses this), with `index.html` fallback for unknown paths so client routing works. `close()` calls `server.stop(true)` and unsubscribes.
- `src/host/token.ts`: `generateHostToken(): string` (32 random bytes, base64url) and `hostTokenPath()` following the same platform layout as `queueStorePath` (file `host-token`). `loadOrCreateHostToken(path)` reads or writes the file with mode 0o600.
- `src/host/plugin.ts`: `createWorkspaceHostPlugin(options: { enabled: boolean; port: number; hostname: string; tokenPath: string | false; staticRoot?: string }): WorkbenchPlugin` with `requires: [workbenchControllerToken, flowRuntimeToken]`. Provides `workspaceHostToken = serviceToken<WorkspaceHost | undefined>('workspace-host')`. `ctx.effect` returns `() => host.close()`. When `enabled` is false, provides `undefined` and starts nothing.
- `src/host/main.ts`: headless entry. Mounts the same plugins as `src/main.tsx` minus the UI plugins and `render`, then the host plugin with `enabled: true`. Prints the URL and token path to stdout. Handles SIGINT/SIGTERM by disposing the kernel.

Files to modify.

- `src/main.tsx`: mount `createWorkspaceHostPlugin` after the controller and flow plugins. Read `HEDDLEWORK_HOST=1` (enable), `HEDDLEWORK_HOST_PORT` (default 4817), `HEDDLEWORK_HOST_BIND` (default `127.0.0.1`). Default is disabled in demo mode and enabled otherwise only when `HEDDLEWORK_HOST=1`. Pass `staticRoot` to the compiled web assets (Phase 3 fills this in; leave `undefined` now).
- `package.json`: add script `"host": "bun src/host/main.ts"`.
- `src/ui/settings-view.tsx`: add a read-only "Remote access" section showing whether the host is running, its URL, and a Copy-token button that goes through the existing `uiRequest` copy path (`{ kind: 'copy', text }`). Pass the host handle down from `src/ui/app.tsx` as an optional prop `host?: WorkspaceHost`. Keep the section hidden when `host` is undefined.
- README: `Configuration` table gets `HEDDLEWORK_HOST`, `HEDDLEWORK_HOST_PORT`, `HEDDLEWORK_HOST_BIND`. Add an `Remote host` subsection under `Install today` describing `bun run host -- /path` and the token file location.

Tests to add.

- `tests/host-server.test.ts`: start a kernel with the demo transport and `createWorkspaceHost` on port 0 (Bun assigns one; read `server.port`). Connect with `new WebSocket(url + '?token=' + token)`. Assert: wrong token gets close code 1008 or HTTP 401; `welcome` arrives with `protocol: 1` and `snapshot.connection === 'connected'` after `controller.start()`; sending `{kind:'command', id:1, command:{type:'setEditorText', text:'hi'}}` yields `result ok` then a `patch` whose `changed.editorText === 'hi'`; sending `submit` yields patches until `session.isStreaming` is false and the last message role is `assistant`; `close()` resolves and the socket closes.
- `tests/host-plugin.test.ts`: mounting with `enabled: false` provides `undefined`; with `enabled: true, port: 0` provides a host whose `close` is called on `kernel.dispose()` (assert a second connect attempt fails).

Acceptance.

- `bun run check` passes.
- Probe: `HEDDLEWORK_DEMO=1 HEDDLEWORK_HOST=1 HEDDLEWORK_HOST_PORT=4817 timeout 8 bun src/host/main.ts /tmp` prints a `ws://127.0.0.1:4817` URL and exits cleanly on timeout.
- The desktop still starts: `HEDDLEWORK_DEMO=1 timeout 6 bun src/main.tsx /tmp` exits without a stack trace (GPUIX may need a display; if it fails only for lack of a display, record that and move on).

---

## Phase 3: Web workspace client

Goal. An installable browser client at `src/web/` that connects to the Phase 2 host, renders the transcript, queue, sessions, flows, diff, and settings using the shared projection modules, and sends `WorkbenchCommand`s. It is a second renderer for the same state, not a port of GPUIX components. Do not import anything from `src/ui/*.tsx`.

Files to create (all under `src/web/`).

- `index.html`: minimal shell with `<div id="root">`, viewport meta, `theme-color`, and a `<link rel="manifest">` (Phase 4 adds the manifest; leave the link in place now pointing at `manifest.webmanifest`).
- `main.tsx`: `createRoot(document.getElementById('root')).render(<WebApp />)`. Reads connection settings from `location` (`?host=`, `?token=`) falling back to `localStorage['heddlework.host']` and `localStorage['heddlework.token']`.
- `client.ts`: `WorkspaceClient` class. `connect(url, token)`, reconnect with exponential backoff (500 ms to 10 s), `subscribe(listener)`, `getSnapshot(): { status: 'connecting' | 'open' | 'closed'; workspacePath; state: WorkbenchSnapshot | undefined; flows: FlowRuntimeSnapshot | undefined; lastError? }`, `send(command): Promise<void>` that resolves on matching `result`. Applies patches with `{...state, ...patch.changed}`. Pure TypeScript, no React, so it is testable in Bun.
- `store.ts`: `useWorkspace()` hook built on `useSyncExternalStore` over `WorkspaceClient`.
- `app.tsx`: layout with a sessions rail (collapsible on narrow screens), the conversation column, and a right drawer for Diff, Flows, Settings. Use CSS in `styles.css` with CSS variables mapped from `src/ui/theme.ts` `ResolvedTheme` colours so both surfaces share palettes.
- `transcript.tsx`: uses `groupWorkItems` and `projectTranscriptRows` from `src/ui/transcript-projection.ts` and `buildTimeline` (or the equivalent exported by `src/workbench/timeline.ts`; read that file for the actual name) to render rows. Markdown via `src/ui/markdown-source.ts` segments rendered to DOM elements; math via `src/ui/math-segment.ts` with MathJax already in dependencies (`@mathjax/src`), lazy-loaded. Tool rows collapsed by default with expand toggles, mirroring the GPUIX disclosure model.
- `composer.tsx`: textarea, Enter to submit, Shift+Enter newline, Alt+Enter to queue, image paste to `addEditorImage` semantics (send as data URL through a new `addEditorImage {image}` command; add that command to Phase 1's union in this phase and add it to `applyWorkbenchCommand`). Abort button while streaming.
- `queue.tsx`: list of queue rows from `state.queue.items` using `queueItemsInDeliveryOrder`, with edit, remove, move, lane switch, pause, steer buttons mapped to commands.
- `sessions.tsx`: `state.sessions` list, switch on click, load more.
- `flows.tsx`: `projectFlowRuns(state)` rendered as run cards with task rows and status pills. Read-only, same as desktop.
- `diff.tsx`: `state.workspaceDiff.files` with per-file unified patch rendered line by line, added/removed colouring, and a refresh button.
- `settings.tsx`: model select (from `state.models`), thinking select, connection details, disconnect.
- `dialogs.tsx`: renders `state.dialog` for select, confirm, input, editor kinds and sends `respondToDialog`. Ask-user questionnaire renders the tool's questions (see `src/workbench/ask-user.ts` for the shape) and sends `submitAskUserQuestionnaire`.

Build.

- `scripts/build-web.ts`: `Bun.build({ entrypoints: ['src/web/main.tsx'], outdir: 'dist/web', target: 'browser', minify: true, sourcemap: 'linked', define: { 'process.env.NODE_ENV': '"production"' } })`, then copy `index.html`, `styles.css`, and later the manifest and icons into `dist/web`.
- `package.json`: scripts `"build:web": "bun scripts/build-web.ts"`, `"dev:web": "bun scripts/dev-web.ts"` where `dev-web.ts` runs `Bun.build` in watch mode (or a simple rebuild loop on file change) and starts the host with `staticRoot: 'dist/web'`. Make `bun run build` call `build:web` first, then the desktop build, and have `scripts/build.ts` embed `dist/web` by adding it to the compile through `Bun.build`'s `--asset` equivalent, or simpler: at desktop runtime resolve `staticRoot` next to the executable (`dirname(process.execPath)/web`) and copy `dist/web` there in `scripts/build.ts`. Pick the simpler path and document it.
- `src/main.tsx`: pass `staticRoot` resolved as above when the directory exists.
- `tsconfig.json`: add `"lib": ["ESNext", "DOM", "DOM.Iterable"]` if not present. If DOM types conflict with GPUIX types, create `src/web/tsconfig.json` extending the root with DOM lib and add `"typecheck:web": "tsc --noEmit -p src/web"` to `check`.

Tests to add.

- `tests/web-client.test.ts`: `WorkspaceClient` against the Phase 2 host in-process. Assert welcome populates `state`, patches merge, `send` resolves on result, reconnect happens after `host.close()` and a new host on the same port (use port 0 twice and update the URL, or test backoff by observing `status` transitions).
- `tests/web-build.test.ts`: `Bun.build` of `src/web/main.tsx` with `target: 'browser'` succeeds and the output contains no `node:` specifier.
- `tests/web-transcript-projection.test.ts`: the DOM-free row projection used by `transcript.tsx` (extract row building into `src/web/rows.ts`) yields the same row kinds as the GPUIX transcript for a fixture transcript from `tests/fixtures`.

Acceptance.

- `bun run check && bun run build:web` passes.
- Probe with Aside (load the `aside-browser` skill): start `HEDDLEWORK_DEMO=1 bun run dev:web -- /tmp`, open `http://127.0.0.1:4817/?token=...`, type a prompt, confirm a streamed assistant response appears, open Diff and Flows drawers. Record a screenshot to `screenshots/web-preview.png`.
- README: status table row `Web and mobile companions` becomes `Preview` for web; roadmap checks `Web workspace client`; the `Install later` table's Web row becomes an `Install today` subsection.

---

## Phase 4: Mobile companion (PWA)

Goal. Make the web client installable on iOS and Android and tune it for the companion use cases the README names: steering, approvals, notifications, task triage, artifact review. Native wrappers are out of scope; the PWA is the mobile client.

Files to create or modify.

- `src/web/manifest.webmanifest`: name, short_name `Heddlework`, `display: standalone`, `start_url: /`, theme and background colours, icons 192 and 512 generated from `media/` or `packaging/linux` icon (convert with the existing icon source; if only SVG exists, ship the SVG plus a rasterised PNG produced by `bun scripts/render-icons.ts` using `@napi-rs/canvas` if available, otherwise commit PNGs produced once locally).
- `src/web/sw.ts`: service worker that precaches the app shell (index, JS, CSS, manifest, icons) with a cache name that includes the build hash, network-first for `/` so new builds propagate, and never caches WebSocket or API paths. Register it from `main.tsx` when `navigator.serviceWorker` exists.
- `src/web/notifications.ts`: request Notification permission from a settings toggle; when the tab is hidden and a `patch` sets `session.isStreaming` from true to false, or `dialog` becomes defined, post a local notification with the workspace basename. No push server in this phase.
- Layout: in `styles.css` add breakpoints at 720 px and 1080 px. Below 720 px the sessions rail and drawers become full-screen sheets with a bottom tab bar (Chat, Queue, Triage, Diff). Composer stays pinned above the keyboard using `100dvh` and `env(safe-area-inset-bottom)`.
- `src/web/triage.tsx`: uses `terminalFlowTasks(projectFlowRuns(state))` and thread lifecycle to list succeeded and failed items with settle, snooze (presets 1 h, tonight, tomorrow), and mark-read actions mapped to commands.
- Approvals: `dialogs.tsx` renders `confirm` dialogs as a bottom sheet with large Approve and Deny buttons and the countdown from `deadlineAt`.
- Artifact review: `diff.tsx` gets a file list first view with per-file navigation and a wrap toggle; this is the mobile artifact review surface until Phase 6 adds receipts, at which point receipts appear here too.
- Host discoverability: `src/host/server.ts` prints and the desktop Settings shows a QR code encoding `http://<lan-ip>:<port>/?token=<token>`. Generate the QR as an SVG string with a small dependency-free encoder in `src/web/qr.ts` (implement byte mode, EC level M, versions 1 to 10; there are compact reference implementations to follow). Desktop shows the SVG through GPUIX only if GPUIX supports SVG paths (check `src/ui/icons.tsx` for how paths are drawn); otherwise show the URL text and a Copy button. Binding to LAN requires `HEDDLEWORK_HOST_BIND=0.0.0.0` and is off by default.

Tests to add.

- `tests/web-qr.test.ts`: encode a known string and compare the module matrix against a reference for version 1 M (hard-code the expected matrix from a verified generator).
- `tests/web-sw-build.test.ts`: `sw.ts` builds for the browser target and the precache list matches the files emitted by `build-web.ts`.
- `tests/web-triage.test.ts`: the triage list projection from a fixture state matches the desktop `terminalFlowTasks` output.

Acceptance.

- `bun run check && bun run build:web` passes.
- Lighthouse PWA installability passes when checked through Aside on the served client (manifest and service worker registered, served over localhost is allowed).
- Probe on a phone-width viewport in Aside (`375x812`): bottom tab bar visible, composer above the keyboard region, confirm dialog renders as a sheet. Save `screenshots/mobile-preview.png`.
- README: status row `Web and mobile companions` becomes `Preview`; roadmap checks `Mobile companion clients`; document install-to-home-screen steps.

---

## Phase 5: External plugin discovery and compatibility metadata

Goal. Load third-party workbench plugins from disk at startup with declared compatibility, and refuse incompatible ones without crashing.

Files to create.

- `src/plugins/manifest.ts`: `PluginManifest = { id: string; name: string; version: string; entry: string; heddlework: { api: string } ; surfaces?: boolean; }`. `parsePluginManifest(json: unknown, dir: string): PluginManifest` validates shape and rejects on missing fields with a message naming the file. `HEDDLEWORK_PLUGIN_API_VERSION = '1'` in `src/plugin-api.ts`. `isCompatible(manifest, apiVersion)` uses simple semver-major comparison (`^1` compatible with `1`).
- `src/plugins/discovery.ts`: `discoverPlugins(roots: string[]): DiscoveredPlugin[]` scanning each root for `*/heddlework-plugin.json`. Default roots: `<state dir>/plugins` (same platform layout as `queueStorePath` with folder `plugins`) and `<workspace>/.heddlework/plugins`. Workspace plugins load only when the workspace is trusted: keep a `trusted-workspaces.json` in the state dir and add a `HEDDLEWORK_TRUST_WORKSPACE=1` env override for now; Settings gets a Trust toggle.
- `src/plugins/loader.ts`: `loadExternalPlugins(kernel, discovered, { apiVersion })`. For each compatible manifest, `await import(entryPath)` and expect `export default` to be a `WorkbenchPlugin` or a factory `(api) => WorkbenchPlugin` receiving the `src/plugin-api.ts` namespace object. Mount it; on throw, record `{ id, error }` in a `PluginLoadReport` and continue. Incompatible manifests are recorded with reason `incompatible`. Returns the report; the report is exposed through a `pluginReportToken` service and shown in Settings under a Plugins section (id, version, status, error).

Files to modify.

- `src/main.tsx`: after mounting core plugins and before `render`, call `loadExternalPlugins`. Mount order matters: external plugins must be able to `requires` core tokens, so load them last.
- `src/plugin-api.ts`: add `HEDDLEWORK_PLUGIN_API_VERSION`, `PluginManifest`, `PluginLoadReport`.
- `docs/ui-extensions.md`: add an `External plugins` section with the manifest schema, folder locations, trust rules, and a minimal example plugin that registers one surface through `workbenchUiRegistryToken`.
- README: check `External plugin discovery and compatibility metadata`.

Tests to add.

- `tests/plugin-discovery.test.ts`: create a temp dir with three plugins: a valid one registering a surface, one with `heddlework.api: '2'` (incompatible), one whose entry throws. Assert discovery finds three, loader mounts one, report lists the other two with reasons, and the surface appears in `workbenchUiRegistryToken` snapshot. Assert `kernel.dispose()` removes the surface.

Acceptance. `bun run check` passes and the test above passes; Settings shows the Plugins section in demo mode with `No external plugins` when none are found.

---

## Phase 6: Mutation receipts and artifact review

Goal. Record what each Pi turn changed in the workspace as a durable receipt, and let the user review receipts per session on desktop and web.

Design. A receipt is Heddlework-owned presentation data. It does not change Pi's transcript. It is computed from the git working tree snapshot before and after a turn and from tool calls that touched files.

Files to create.

- `src/receipts/types.ts`: `MutationReceipt = { id: string; sessionPath: string; turn: number; startedAt: number; completedAt: number; files: ReceiptFile[]; tools: { name: string; count: number }[]; commit?: string }`, `ReceiptFile = { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed'; additions: number; deletions: number; patch?: string }`. Keep patches under 200 KiB per receipt; larger ones store `patch: undefined` and `truncated: true`.
- `src/receipts/store.ts`: `FileReceiptStore` with the same atomic JSON pattern as `queue-store.ts`, path `receipts.json` in the state dir, keyed by session path, capped at 200 receipts per session (drop oldest). `ReceiptStoreService = { list(sessionPath): MutationReceipt[]; append(receipt): void; clear(sessionPath): void }`.
- `src/receipts/recorder.ts`: `createReceiptRecorder({ controller, workspaceDiff, store })`. Subscribes to the controller; when `session.isStreaming` flips false to true, capture `baseline = await workspaceDiff.load(workspacePath)`; when it flips true to false, load again and diff the two `WorkspaceDiff` file lists into `ReceiptFile[]` (a file present after and not before is `added`, present in both with changed patch is `modified`, and so on). Count tool names from the messages added during the turn. Append a receipt only when `files.length > 0`. Return a cleanup that unsubscribes.
- `src/receipts/plugin.ts`: `createReceiptPlugin({ path })` requiring controller and diff tokens, providing `receiptStoreToken`, running the recorder under `ctx.effect`.
- Desktop surface: `src/ui/receipts-view.tsx` registered by `src/ui/core-extension.tsx` as a right-side surface titled `Receipts`, listing receipts for the current session with file rows and an expandable patch using the existing diff row rendering from `src/ui/diff-panel.tsx` (extract a `DiffFileRows` component if needed so both surfaces reuse it). Add `receipts: MutationReceipt[]` for the current session to `WorkbenchState` so the protocol carries it, populated by the recorder through a new controller method `setReceipts(receipts)`.
- Web surface: `src/web/receipts.tsx` in the drawer and in the mobile Diff tab.
- Protocol: add `clearReceipts {sessionPath}` to the command union.

Tests.

- `tests/receipt-recorder.test.ts`: fake diff service returning a baseline and then a changed tree; drive the demo controller through one turn; assert one receipt with the expected file statuses and tool counts; a turn with no file changes appends nothing.
- `tests/receipt-store.test.ts`: append, cap at 200, clear, reload from disk.

Acceptance. `bun run check` passes; demo probe shows a receipt after a turn that writes a file (the demo transport may need a scripted tool call that writes a temp file; check `src/pi/demo-transport.ts` for its script and add a `write` step if absent). README checks `Mutation receipts and artifact review` and the status row `Durable dependency graph` becomes `Preview` after Phase 7.

---

## Phase 7: Durable dependency graph and safe checkout lanes

Goal. Let a Flow task declare dependencies on other tasks and run in an isolated git worktree (a checkout lane), with retries, so parallel work cannot clobber the primary working tree.

Design constraints. Pi remains the executor; Heddlework only prepares the worktree, points the Pi session `cwd` at it, and records the outcome. Dependencies gate enqueueing, not Pi behaviour.

Files.

- `src/flows/types.ts`: extend `FlowTemplate` with optional `tasks?: FlowTaskSpec[]` where `FlowTaskSpec = { id: string; prompt: string; dependsOn?: string[]; lane?: 'shared' | 'worktree'; retries?: number }`. `prompts` remains for backward compatibility; `normalizeFlowTemplate` converts `prompts` into `tasks` with sequential `dependsOn` in sequential mode and no deps in parallel mode. Add `validateFlowGraph(tasks)` that rejects cycles and unknown ids with a message naming the offending task.
- `src/flows/graph.ts`: `readyTasks(tasks, completed: Set<string>, failed: Set<string>)` returns tasks whose deps are all completed; tasks with a failed dependency are `blocked`. `topologicalOrder(tasks)`.
- `src/workspace/checkout-lanes.ts`: `CheckoutLaneService = { create(workspacePath, laneId): Promise<{ path: string; branch: string }>; remove(workspacePath, laneId): Promise<void>; list(workspacePath): Promise<Lane[]> }` implemented with `git worktree add -b heddlework/<laneId> <stateDir>/lanes/<hash>/<laneId>` and `git worktree remove --force`. Never touch the primary tree. Provide it as `checkoutLaneToken`.
- `src/flows/runtime.ts`: the compiler for a due launch consults `readyTasks`; for `lane: 'worktree'` tasks it creates a lane and includes the lane path so the queue primitive starts Pi with `cwd` set to the lane. Check how `createAgentTransportPlugin` receives `cwd`; if the transport is fixed per process, the lane runs through a second transport instance keyed by lane, mounted by a `createLaneTransportPlugin(laneId, cwd)` and disposed when the task settles. Record `attempt` and re-enqueue up to `retries` on a failed terminal stop reason (see how `src/flows/projection.ts` derives `failed`).
- Merge back: after a worktree task succeeds, do not auto-merge. Record the lane branch in the task's receipt (`commit` field from Phase 6) and show a `Merge lane` action on the task page that runs `git merge --no-ff heddlework/<laneId>` in the primary tree and removes the lane on success; on conflict, surface the git message and leave the lane in place.
- UI: `src/ui/flows-view.tsx` task page shows dependencies, lane path, attempt count, and the merge action; the intake form gets a dependency picker (multi-select of earlier task ids) and a lane toggle. Web `flows.tsx` mirrors read-only plus the merge action.
- Protocol: `mergeLane {laneId}` and `removeLane {laneId}` commands.

Tests.

- `tests/flow-graph.test.ts`: cycle detection, ready set evolution, blocked on failure.
- `tests/checkout-lanes.test.ts`: in a temp git repo, create a lane, assert `git worktree list` contains it and the primary tree is untouched, remove it.
- `tests/flow-runtime.test.ts`: extend with a two-task graph where task B waits for A, and a retry case.

Acceptance. `bun run check` passes; README checks `Durable dependency graphs and safe checkout lanes` and sets the status row to `Preview`.

---

## Phase 8: Signed desktop installers and automatic updates

Goal. A release workflow that builds macOS, Linux, and Windows executables, signs and notarises when secrets are present, publishes GitHub Releases with checksums, and an in-app update check.

Files.

- `.github/workflows/release.yml`: triggered on tag `v*`. Matrix `macos-latest` (arm64 and x64 via `COMPILE_TARGET=bun-darwin-arm64` and `bun-darwin-x64`), `ubuntu-latest` (`bun-linux-x64`), `windows-latest` (`bun-windows-x64`). Steps: checkout, setup-bun 1.4.0, `bun install --frozen-lockfile`, `bun run check`, `bun run build`, then platform packaging.
  - macOS: wrap `dist/heddlework` in `Heddlework.app` using `packaging/macos/Info.plist` and the icon; when `MACOS_CERT_P12`, `MACOS_CERT_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` secrets exist, run `codesign --deep --options runtime`, zip, `xcrun notarytool submit --wait`, `xcrun stapler staple`. Without secrets, skip signing and name the asset `-unsigned`.
  - Windows: when `WINDOWS_CERT_PFX` and password exist, `signtool sign /fd sha256 /tr http://timestamp.digicert.com`. Produce a zip.
  - Linux: tar.gz plus reuse `packaging/linux` assets.
  - All: `sha256sum` into `checksums.txt`; `gh release create` with generated notes.
- `packaging/macos/`: `Info.plist`, `entitlements.plist` (hardened runtime, no extra entitlements), `build-app.sh`.
- `packaging/windows/README.md` describing the zip and signing.
- `src/updates/check.ts`: `checkForUpdate({ currentVersion, fetch })` calling `https://api.github.com/repos/0xCUB3/heddlework/releases/latest`, comparing semver against `package.json` version embedded at build time (`define` in `scripts/build.ts`), returning `{ available, version, url }`. Runs once at startup after a 10 s delay when `HEDDLEWORK_UPDATE_CHECK !== '0'`, posts a notice through the existing notices channel with the download URL. Full auto-install is out of scope for this phase; the notice links to the release. Document this honestly in the README.
- `package.json`: `"release:tag": "bun scripts/release-tag.ts"` that bumps version, commits, and tags.

Tests.

- `tests/update-check.test.ts`: fake fetch returning a newer and an older tag; assert `available` flips correctly and network failure returns `{ available: false }` without throwing.

Acceptance. Workflow YAML validates (`gh workflow view release.yml` after push, or `actionlint` if available). A dry run on the fork with a `v0.1.1-rc.1` tag produces unsigned assets on a GitHub pre-release. README checks `Signed desktop installers and automatic updates` with a note that signing activates when secrets are configured and the status row `Signed desktop distribution` becomes `Preview (unsigned until certificates are configured)`.

---

## Final pass

1. README: status table, roadmap checkboxes, `Install later` table reduced to what is still not shipped (Codex, Claude, native mobile wrappers, auto-install updates).
2. `docs/` index in README architecture section links `harness-adapter-protocol.md`, the plugin section, receipts, lanes, and the web client.
3. `bun run check && bun run build && bun run build:web` green on a clean checkout (`git stash -u` any local noise first, or clone to a temp dir).
4. Push `main` to `origin` (0xCUB3). Do not open an upstream PR unless asked.

## Prewalk notes for the executor

- Each phase is a separate `fabric_exec` sequence: read named files, edit, run `bun run check`, fix, commit, push. Do not batch two phases into one commit.
- When `bun test` fails in a GPUIX UI test after a change in `src/ui/`, read the failing assertion before editing; the UI tests drive the real reconciler and are sensitive to element order.
- If an existing test enumerates plugins mounted by `src/main.tsx`, update it when adding the host, receipts, or plugin-loader plugins.
- If Bun's `WebSocket` client in tests lacks a feature, use `Bun.connect` only as a last resort; the standard `WebSocket` global works in Bun 1.4.
- Never modify files under `node_modules/` or `dist/`.

## Status

All eight phases are on `main` of `0xCUB3/heddlework`: protocol `f9345b0`, host `2f88595`, web `d3b9afd`, PWA `6c7e60d`, plugins `e947133`, receipts `46b21a3`, flows graph and lanes `bde6309`, release `660698b`. Tag `v0.1.1-rc.1` (at `e4fa9eb`) ran the release workflow to completion and published a pre-release with macOS arm64/x64, Linux, and Windows archives plus `checksums.txt`. The GPUIX UI suites had been failing on hosted macOS since before this work (same on upstream) because the runner's 1024x768 virtual display clamps test windows to tablet width; `scripts/ci-display.sh` now widens the display, and one glyph centring assertion that only held at 2x scale was fixed. `check.yml` is green at 305 pass and the release jobs run the full check on macOS and Linux. The notes below are the earlier handoff and are kept for history.

## Status at handoff (historical)

- Phase 1 is complete on `main` (commit `f9345b0`, `feat(protocol)`).
- Phase 2 is implemented on branch `phase-2-host` (`src/host/*`, `tests/host-*.test.ts`, README env table and Remote host section). Its own tests pass and `bun src/host/main.ts` runs in demo mode. One pre-existing UI test fails on that branch: `tests/ui.test.tsx` "renders and operates the T3-style native workbench shell", assertion at line 577, because the new Remote access section in `src/ui/settings-view.tsx` pushes the `settings-alpha` row below the settings viewport. Fix by placing the Remote access section after About, or by shrinking it to one row when `host` is undefined, then run `bun run check`, squash to `feat(host): ...`, and merge to `main`.
- Phases 3 to 8 are not started.
