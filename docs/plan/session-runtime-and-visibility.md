# Visible execution and sessions that outlive the app

The desktop window should be a client, not the owner of an agent's lifetime. Tool results should be readable without opening several layers of disclosure. These are separate changes, but both belong on the same host/client boundary.

This is a researched design, not an implemented runtime migration. The selection styling was pushed in `84088b4` before this investigation.

## What the screenshots expose

Pi TUI shows a milestone, its description, a read operation with a file range, a syntax-highlighted excerpt, hidden-line count, tool duration, and turn metrics. Heddlework shows a generic Working group, a collapsed completed call, and a generic preparing call. The captures are not proof of identical event timing, but the rendering defaults explain the loss of visibility.

Local source and behavioral probes confirm three causes.

- `src/ui/transcript.tsx` initializes entry disclosures closed. `src/ui/transcript-tools.tsx` renders code, output and milestone descriptions only when expanded. Collapsed nested calls are mostly a path and status.
- `src/workbench/state.ts` accumulates streamed tool arguments in `argsText`. The Fabric presenter in `src/ui/tool-presenters.ts` reads `args`, not the partial text. A preparing call with a readable partial display name still becomes `Fabric execution` with no code preview.
- `src/workbench/timeline.ts` classifies telemetry as a context injection inside the work trace. `tests/telemetry.test.ts` explicitly enforces that placement. TPS, TTFT, token counts and stalls are already supported by `src/workbench/telemetry.ts`; this is not primarily a missing-data problem.

Persisted Fabric audits already retain arguments, results and durations when supplied. Not every extension supplies the same structured details, so the UI must distinguish absent data from data it has hidden. TUI extension renderers are not portable GPUix components. Reuse their structured records and presentation semantics, not their terminal drawing code.

## Visibility treatment

1. Make a balanced activity view the default. Show the current milestone, description and a bounded preview of the latest operation. Keep completed older work compact. Offer a persistent detailed mode that expands tool previews throughout the thread.
2. Render operations by meaning. Reads show path, range, language and a short numbered excerpt. Edits show an actual diff when supplied. Shell commands show the command and a live output tail. Searches show representative matches and counts. Unknown tools keep a readable structured fallback.
3. Give Fabric one milestone header with child operations. Show running children, completed counts, failures and durations. Do not require expanding the outer call merely to see what a child read returned. Keep the orchestration TypeScript available behind its own disclosure rather than placing it ahead of every useful result.
4. During argument generation, show that the call is being prepared and preview available argument text safely. Extract display metadata only with a bounded tolerant parser. Never imply an operation has started before the execution-start event arrives.
5. Put available turn metrics in a small turn footer. Associate them by turn identity, not adjacency, and update the footer when telemetry arrives late. Unknown metrics stay absent. Do not manufacture TPS or timing from transcript timestamps.
6. Keep truncation explicit. A preview reports hidden lines and offers expansion or access to the complete retained result. Large results remain virtualized. User expansion and scroll position must survive incoming events and reconnection.
7. Use the same presentation records on GPUix, web and SwiftUI. Mobile can preview fewer lines, but must retain the operation, state, error and expansion affordance. Do not expose hidden model reasoning; display only reasoning or progress actually supplied by the harness.

## What t3code does

Inspected upstream `pingdotgg/t3code` at `dc39615aec702ea6d402168f80b4d1613f4f2e0f`.

Its local desktop runtime does not preserve uninterrupted execution through a full quit or update. [DesktopApp.ts](https://github.com/pingdotgg/t3code/blob/dc39615aec702ea6d402168f80b4d1613f4f2e0f/apps/desktop/src/app/DesktopApp.ts#L304-L330) stops every managed backend during shutdown. [DesktopUpdates.ts](https://github.com/pingdotgg/t3code/blob/dc39615aec702ea6d402168f80b4d1613f4f2e0f/apps/desktop/src/updates/DesktopUpdates.ts#L585-L606) explicitly stops them before `quitAndInstall`. This finding concerns desktop-managed local backends, not an independently operated remote server.

It does have durable recovery worth adapting.

- [ProviderSessionRuntime.ts](https://github.com/pingdotgg/t3code/blob/dc39615aec702ea6d402168f80b4d1613f4f2e0f/apps/server/src/persistence/ProviderSessionRuntime.ts#L35-L53) stores thread/provider identity, status, resume cursor and runtime payload.
- [ProviderService.ts](https://github.com/pingdotgg/t3code/blob/dc39615aec702ea6d402168f80b4d1613f4f2e0f/apps/server/src/provider/Layers/ProviderService.ts#L2010-L2069) can mark running turns for continuation, then calls each adapter's `stopAll`.
- [serverRuntimeStartup.ts](https://github.com/pingdotgg/t3code/blob/dc39615aec702ea6d402168f80b4d1613f4f2e0f/apps/server/src/serverRuntimeStartup.ts#L476-L725) reconciles orphaned sessions. It checks turn identity, resume state, archived/deleted state and durable preparation markers. It starts a continuation turn, using promptless continuation when the adapter supports it and a continuation prompt otherwise. This is recovery, not resuming a JavaScript stack or a shell command at its old instruction.
- [settings.ts](https://github.com/pingdotgg/t3code/blob/dc39615aec702ea6d402168f80b4d1613f4f2e0f/packages/contracts/src/settings.ts#L854-L857) defaults the restart-continuation preference to false. Reconciliation also handles marked update continuations and qualifying opt-in crash recovery.

Copy the registry and reconciliation principles, not the desktop-owned process lifetime. Any substantial source copied later must retain t3code's MIT notice. Its Effect/provider implementation is not a drop-in replacement for Heddlework's Pi RPC transport.

## Heddlework's current lifetime

`src/main.tsx` disposes the kernel on shutdown. The transport plugin in `src/workbench/plugins.ts` calls `transport.stop()` during disposal. `src/pi/rpc-transport.ts` closes Pi's stdin, sends SIGTERM, and escalates to SIGKILL after one second. A fake-Pi process probe confirms that stopping the transport exits the child.

Removing that kill is insufficient. The GUI still owns the RPC pipes, event processing, queues and approvals. A detached child without a persistent RPC owner is not a reconnectable session.

There is already a useful starting point in `src/host/main.ts`. It runs the kernel without GPUix and serves the existing host protocol. WebSocket disconnect in `src/host/server.ts` removes client presence, not the controller. Web and iOS already follow this client model. The native desktop must use it too.

## Recommended runtime boundary

Use a per-user background Heddlework runtime, supervised by a macOS LaunchAgent. It owns Pi RPC processes, session controllers, queue scheduling, terminal backends, durable state and remote-client connections. GPUix stays in the desktop client. Window drawing and native browser projection stay client-side behind explicit service interfaces.

The runtime needs a registry of live sessions, not just the current foreground conversation. Use canonical session identity and the Pi session file to route each client to the correct controller. Selecting a different thread must never swap out or terminate another running agent. Reuse the existing headless host and protocol rather than create a second independent backend.

The GUI connects over an authenticated local endpoint. It can disconnect, crash, quit or be replaced without stopping agents. Reopening attaches to the existing runtime and receives a current snapshot. An explicit Stop agent action stops one session. Stop all agents and quit remains a separate deliberate action. Closing the last window is not an implicit cancellation.

Keep the runtime executable and its required resources in versioned application-support storage, outside the app bundle being replaced. An app update must not restart a busy runtime. Negotiate protocol compatibility and defer runtime replacement until agents are idle unless the user explicitly chooses interruption. Pinning only a PID while deleting its lazily loaded resources is not sufficient.

Persist a small runtime registry and an ordered event/command journal. Keep Pi JSONL as the canonical conversation history. Persist session identity, workspace, runtime version, run identity, lifecycle state, event cursor and pending interaction metadata. Bound journal retention and result storage. A reconnect uses a snapshot plus replay cursor; it does not submit the last prompt again.

Use command IDs and durable admission records so reconnect retries cannot submit a prompt twice. Exactly-once external side effects cannot be promised after an unknown crash. A lost acknowledgement must not cause an automatic rerun of a shell command or tool call. Keep one authoritative owner per session and lock runtime startup to prevent duplicate hosts.

Pending approvals remain pending while no suitable client is connected. Reconnection must neither auto-approve nor silently discard them. Keep local credentials owner-only and do not expose a network listener merely to support native reconnection. Existing remote-access authorization remains explicit.

## Failure boundaries

An ordinary app quit, restart or update should preserve the same live Pi processes and in-flight work. A runtime crash, machine shutdown or reboot cannot promise that continuity. Recover history and mark uncertain runs interrupted. Offer continuation only through explicit policy and the harness's supported resume mechanism, with t3code-style stale-marker checks. Never turn an uncertain interrupted tool call into a reported success.

For the first version, retain the running runtime until idle rather than attempt live process migration. Separate per-session worker supervision can be added later if runtime crash isolation becomes necessary. It is not needed to solve GUI restarts.

## Implementation order and acceptance

1. Add balanced/detailed transcript presentation and move telemetry to turn footers. Replay the supplied kind of Fabric read through GPUix and DOM fixtures. Verify milestone, description, file range, excerpt, duration and late telemetry without opening nested disclosures. Verify partial argument previews and tool-start boundaries separately.
2. Extract a platform-neutral client/controller interface from the existing remote path. Keep GPUix rendering native. Test session routing, reconnect and pending approvals with two clients before changing desktop startup.
3. Promote the headless entry to the supervised runtime and persist its session registry. Start one runtime under concurrent launches. Route multiple live sessions independently. Keep runtime and UI version negotiation explicit.
4. Move native startup to attach-or-start. Start a long fake-Pi turn, quit the GUI, and verify its PID and emitted event sequence continue. Reopen and verify the same run appears with complete output. Repeat with two sessions, a running terminal and a pending approval.
5. Decouple app installation from runtime replacement. Run the actual development installer during an active fixture turn. Verify the same Pi PID survives and the replaced client reconnects without resubmission. Test incompatible protocol handling without killing work.
6. Add crash recovery as a separate guarantee. Crash the runtime before admission, after admission and during a tool call. Assert no duplicate prompt admission, honest interrupted status, preserved completed results and no automatic replay of uncertain side effects. Test stale continuation markers, archived sessions and cancelled sessions.
7. Run GPUix/web/iOS checks and long-transcript performance probes. Exercise output truncation, bounded replay, dropped sockets, repeated reconnects and two clients submitting the same command ID. Verify UI-only quit and explicit stop remain observably different.

## Evidence gathered

The local preparing-call probe returned `Fabric execution` with an empty code presentation despite populated partial argument text. The telemetry probe returned `context-injection`. The transport probe used `tests/fixtures/fake-pi.ts`, not a real agent, and verified its process exited on stop.

The existing Fabric presenter, telemetry, host-server and RPC transport suites passed together with 14 tests. t3code findings are source and test-code inspection at the pinned commit, not a claim that its desktop recovery suite was run locally.
