# Terminal

Heddlework owns PTY sessions in-process. The VT emulator and GPUIX painter stay on the client side of that byte stream so a later `libghostty-vt` (native or WASM) renderer can replace the current emulator without changing spawn, attach, resize, or the bottom/right placements.

## Placements

- **Bottom dock** — layout-owned in `WorkbenchApp`. Toggle from the chat header. Sessions stay alive when the dock closes.
- **Right surface** — the existing `terminal` workbench surface. The same `TerminalSessionService` backs both views; the most recently focused placement owns PTY rows/cols.

## Runtime

- Default backend: `Bun.Terminal` via `BunPtyBackend`.
- Platform adapters can inject the exported `TerminalBackend` contract.
- Tests: `MemoryTerminalBackend`.
- Shell: `$SHELL -l` (or `cmd.exe` on Windows), `TERM=xterm-256color`.

## GPUIX focus boundary

GPUIX dispatches its native `FocusNext`/`FocusPrevious` actions after `keyDown`, so an application handler cannot cancel Tab traversal. The terminal input therefore sets the native `captureTab` host prop. `patches/gpuix-0.6.0-capture-tab.patch` contains the tested GPUIX 0.6.0 bridge, native renderer, typings, and regression test needed until that API is available in a published GPUIX release.

Web and mobile companions should keep this split: host PTY, Ghostty VT ABI, platform painter.
