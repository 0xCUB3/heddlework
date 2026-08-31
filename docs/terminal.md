# Terminal

Heddlework owns PTY sessions in-process. The byte stream, VT state, and painter are separate so desktop can use native GPUI today while a future web/mobile client can keep the same session contract and substitute a WASM VT engine and browser painter.

## Placements

- **Bottom dock** — layout-owned in `WorkbenchApp`; sessions stay alive when the dock closes.
- **Right surface** — the existing `terminal` workbench surface.
- Both placements share `TerminalSessionService`. The most recently focused placement owns PTY rows and columns.

## Runtime

- Default backend: `Bun.Terminal` through `BunPtyBackend`.
- Platform adapters can inject the exported `TerminalBackend` contract.
- Tests use `MemoryTerminalBackend` or a push-driven backend.
- Shell: `$SHELL -l` (or `cmd.exe` on Windows), with `TERM=xterm-256color` and `COLORTERM=truecolor`.

## Output and presentation pacing

Heddlework follows the important invariants from Localterm without moving browser-specific xterm behavior into the native app:

1. PTY chunks are parsed immediately on arrival. Device-status and capability queries are answered in the same task rather than being delayed behind a render callback.
2. Ordinary presentation notifications are coalesced to a 16 ms frame deadline. The deadline is measured from the previous frame start, so React/native paint work does not accumulate on top of every interval. Parsing never runs inside the timer.
3. DEC private mode 2026 holds the last committed grid while a synchronized frame is incomplete. The completed frame publishes immediately; a 150 ms stale-frame escape hatch prevents a broken application from freezing the surface indefinitely.
4. User input can preempt a held synchronized frame, preserving interactive latency.
5. A detached scrollback viewport is anchored as new rows arrive. Explicit terminal input returns to the live tail.

`VtEmulator.snapshot()` caches immutable rows by mutable-row revision. A one-cell update only freezes that row; all unchanged row objects retain identity. On a patched GPUIX runtime, `TerminalView` projects the visible snapshot to a deduplicated style table plus compact `[row, column, columns, style, text]` tuples and updates one native host element. Stock GPUIX 0.6 uses the memoized React-run fallback.

Run the repeatable hot-path benchmark with:

```bash
bun run benchmark:terminal
```

It reports incremental snapshots, a 5 MiB ANSI parse, full row-style projection, unchanged-row identity reuse, and a synchronized 160×50 high-churn TUI frame through VT parsing, React, NAPI, GPUI layout, and paint. The native benchmark also reports retained-node count. On the development machine after glyph warmup, the complete animated frame measured 1.21 ms median / 3.84 ms p95 with three retained nodes, compared with the previous 6,054-node React surface at roughly 72 ms per frame. Treat timings as hardware-dependent; node count and row reuse are structural guards.

## Native rendering versus xterm.js

The xterm.js/WebGL fork in Localterm is not copied into the desktop bundle. Instead, Heddlework adds the missing low-level primitive to GPUIX: one fixed-cell `<terminal>` host consumes a compact complete-frame prop and paints directly into the GPUI scene.

The native surface preserves terminal geometry rather than treating the grid as flexbox text:

- every text run is shaped with GPUI's `force_width` cell advance, including long box-drawing runs, so the first and rightmost columns stay attached;
- double-width glyphs carry explicit column counts and force the following cell into a new run;
- backgrounds, cursor, underline, strike, and block elements are painted at exact fractional grid coordinates;
- same-style cells remain one shaped run, preserving programming ligatures without per-cell retained nodes;
- disabling ligatures inserts zero-width non-joiners; Nerd Font ranges can use a separate family;
- bold base ANSI colors resolve to bright variants, and muted emoji requests text presentation (`VS15`).

This is also the Localterm alpha-mask optimization in native form. GPUI's text system caches ordinary glyphs as `MonochromeSprite` coverage in an R8/A8 atlas, then applies terminal foreground color during GPU composition. There is no browser canvas polarity to reconstruct and no second xterm/WebGL atlas to maintain. Emoji that remain color presentation use GPUI's polychrome atlas; `VS15` routes supported muted forms through the monochrome coverage path. Platform color-font fallback can still override unsupported text-presentation sequences.

## Fonts and live settings

Settings → **Terminal** applies changes to every open terminal without restarting its PTY:

- primary installed font family;
- programming ligatures;
- Nerd Font symbol routing and fallback family;
- muted emoji.

The native text system resolves installed font family names. Heddlework does not bundle Localterm's WOFF2 webfonts because GPUIX 0.6 does not expose runtime font-byte registration to React hosts. A full Nerd Font can also be selected directly as the primary family.

Preferences are stored in `terminal.json` under the platform application configuration directory:

- macOS: `~/Library/Application Support/Heddlework/terminal.json`
- Windows: `%APPDATA%/Heddlework/terminal.json`
- Linux: `${XDG_CONFIG_HOME:-~/.config}/heddlework/terminal.json`

Plugin hosts can override or disable the path through `createTerminalPlugin({ appearancePath })` and can provide initial values with `appearance`.

## Color, gamma, and light mode

The first 16 ANSI colors are theme anchors. Indices 16–255 are regenerated in CIELAB space as a 216-color cube plus a 24-step grayscale ramp, avoiding the harsh and low-contrast fixed xterm cube on light themes.

Light mode enforces a 4.5:1 minimum foreground/background contrast ratio using WCAG relative luminance. Color adjustment and dim compositing happen in linear sRGB rather than interpolating gamma-encoded channel bytes. Dim dark-on-light text uses the Localterm-derived 0.9 opacity policy and is checked again after blending; dark themes retain author colors and use the conventional 0.5 dim blend.

## GPUIX focus boundary

GPUIX dispatches its native `FocusNext`/`FocusPrevious` actions after `keyDown`, so an application handler cannot cancel Tab traversal. The terminal input sets the native `captureTab` host prop. `patches/gpuix-0.6.0-heddlework.patch` contains the tested GPUIX 0.6.0 capture bridge and terminal primitive, including native/React typings, renderer capability detection, documentation, and regression tests. The application feature-detects `supportsNativeTerminal()` and remains buildable against an unpatched package.

## Web and mobile path

Keep the current split for companion clients:

1. a host process owns the PTY and transports ordered bytes plus resize/input events;
2. Ghostty's VT core, compiled natively or to WASM, can replace `VtEmulator` behind the snapshot/session boundary;
3. each platform owns its painter: GPUI on desktop, a browser renderer on web, and a platform view on mobile. The compact terminal frame contract is platform-neutral, and the Rust painter has no desktop-only text API, so a GPUIX WebAssembly renderer can expose the same host element.

The Localterm xterm/WebGL work remains an appropriate browser implementation when GPUIX/WASM is not the UI host. Heddlework shares pacing, color, font, frame, and accessibility policy rather than importing browser renderer internals into desktop.
