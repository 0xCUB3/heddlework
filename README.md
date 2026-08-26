# Pi Workbench

A first native desktop workbench for [pi](https://github.com/earendil-works/pi), rendered with [GPUIX](https://github.com/remorses/gpuix).

The desktop experience closely adapts the MIT-licensed [T3 Code](https://github.com/pingdotgg/t3code) control surface for Pi: searchable threads, project-oriented navigation, a centered conversation timeline, compact tool disclosures, and a floating composer. Browser integration remains out of scope.

## Features

- Native shell reproduced against a locally run T3 Code reference: neutral chrome, centered draft composer, top-aligned threads, and compact header actions
- Searchable, clickable persisted Pi sessions discovered across Pi's global JSONL session directory with bounded fast-path scans
- Hover copy/revert actions, macOS clipboard-image prompts, and functional Active, Snoozed, and Settled thread groups
- Streaming markdown, expandable reasoning, and collapsed “Worked for” tool summaries
- Specialized `bash`, `read`, `edit`, and `write` tool details, rich nested `fabric_exec` audit disclosures, and changed-file summaries with direct Diff access
- Functional split-pane Git working-tree review with native unified diff rendering
- Opaque two-second notification toasts with an unread badge and a dedicated right-side notification ledger
- Persistent Pi sessions through `pi --mode rpc`
- New/switch/export session, prompt, steer, abort, model, thinking, and compaction controls
- Open a second project in a separate native workbench process
- Pi extension `select`, `confirm`, `input`, `editor`, notification, status, widget, title, and editor-text requests
- Reconnect behavior and process error reporting
- A no-credentials demo transport for UI development

## Requirements

- Bun 1.3+
- A working `pi` command on `PATH`
- A platform supported by GPUIX (`macOS`, Linux, or Windows)

On macOS, the prebuilt GPUIX package is sufficient. Building GPUIX itself requires Xcode and the Metal toolchain.

## Run

```sh
bun install
bun run dev -- /path/to/repository
```

Use the non-hot entry point when validating process lifecycle:

```sh
bun run start -- /path/to/repository
```

Run the UI without starting Pi:

```sh
bun run demo -- /path/to/repository
```

If `pi` is not discoverable from the application environment:

```sh
PI_WORKBENCH_PI=/absolute/path/to/pi bun run start -- /path/to/repository
```

Optional environment variables:

| Variable | Purpose |
|---|---|
| `PI_WORKBENCH_CWD` | Workspace path instead of the positional argument |
| `PI_WORKBENCH_PI` | Absolute Pi executable path |
| `PI_WORKBENCH_PROVIDER` | Initial provider passed to Pi |
| `PI_WORKBENCH_MODEL` | Initial model passed to Pi |
| `PI_WORKBENCH_NO_SESSION=1` | Disable Pi session persistence |
| `PI_WORKBENCH_DEMO=1` | Use the deterministic demo transport |
| `PI_WORKBENCH_DEBUG_OVERLAY=full` | Show GPUIX frame timings |

## Verify

```sh
bun run check
bun run build
```

The compiled executable is written to `dist/pi-workbench`. It still launches the installed `pi` executable as a sidecar; bundling Pi itself is deliberately deferred.

## Architecture

The desktop shell follows a small subset of Cordis's design:

- `src/core/kernel.ts` owns services, keyed contribution slots, plugin scopes, and reverse-order cleanup.
- `src/pi/transport.ts` is the provider-neutral agent transport seam.
- `src/pi/rpc-transport.ts` is the real Pi provider and implements strict LF-only JSONL framing.
- `src/pi/session-catalog.ts` performs bounded global scans of Pi's persisted session metadata for the clickable thread sidebar.
- `src/workspace/git-diff.ts` loads tracked and untracked patches through argument-safe Git processes.
- `src/workbench/controller.ts` projects RPC events into UI state, switches sessions, tracks thread lifecycle metadata, and rehydrates from Pi's authoritative transcript.
- `src/ui/tool-presenters.ts` is a keyed, reversible UI contribution slot.
- `src/ui/` contains the GPUIX shell; it does not own agent or session truth.

Pi remains the source of truth for messages and sessions. Streaming state is temporary and is replaced by `get_messages` after completion.

## Current limitations

- Each window owns one active project and Pi process; opening another project starts another window.
- Project selection currently uses an absolute-path input rather than a native file picker.
- No terminal emulator or code editor yet.
- Snooze/settle metadata and notification history currently live for the lifetime of the workbench process.
- Pi TUI-only custom components cannot be represented over RPC; the standard extension UI protocol is supported.
- Packaging is an unsigned executable, not a notarized installer.

See [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) for T3 Code and icon attributions.
