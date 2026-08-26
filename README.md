# Pi Workbench

A first native desktop workbench for [pi](https://github.com/earendil-works/pi), rendered with [GPUIX](https://github.com/remorses/gpuix).

The current version is intentionally focused: one workspace, one active Pi session, a native transcript, model controls, tool cards, extension prompts, and a durable Pi subprocess. Browser integration is out of scope.

## Features

- Native GPUIX window with a virtualized transcript
- Streaming markdown and reasoning display
- Specialized `bash`, `read`, `edit`, and `write` tool cards
- Native code and unified diff rendering
- Persistent Pi sessions through `pi --mode rpc`
- New session, prompt, steer, abort, model, thinking, and compaction controls
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
- `src/workbench/controller.ts` projects RPC events into UI state and rehydrates from Pi's authoritative transcript.
- `src/ui/tool-presenters.ts` is a keyed, reversible UI contribution slot.
- `src/ui/` contains the GPUIX shell; it does not own agent or session truth.

Pi remains the source of truth for messages and sessions. Streaming state is temporary and is replaced by `get_messages` after completion.

## Current limitations

- Only the active session is shown; a cross-project recent-session browser is not implemented yet.
- No native file picker, terminal emulator, or code editor.
- Pi TUI-only custom components cannot be represented over RPC; the standard extension UI protocol is supported.
- Packaging is an unsigned executable, not a notarized installer.
