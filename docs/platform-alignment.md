# Platform alignment audit

Compared on 2026-09-08 against GPUix `6b4be86`, Zed `81c99f816b`, and
[0xCUB3/heddlework](https://github.com/0xCUB3/heddlework) `d55e9ad`.

## Acceptance ledger

- [x] Inspect both supplied layout screenshots and trace their layout owners.
- [x] Compact the browser-only header and toolbar; preserve other surface headers.
- [x] Use equal unpadded flex columns for surface cards and the trailing empty cell.
- [x] Reserve two description lines so Agents does not grow relative to other built-in cards.
- [x] Port stationary browser placement backoff and exercise geometry/visibility changes.
- [x] Centralize browser-aware traffic-light detection in all shared titlebar owners.
- [ ] Reconcile the native GPUix/Zed branches with current upstream and regenerate the pinned patch/artifact.
- [ ] Port authenticated host/protocol, then the DOM client using our existing UI.
- [ ] Port session/streaming performance changes with their race and pagination tests.
- [ ] Expose native window decoration state and actions; implement Linux client-side controls.
- [ ] Validate Wayland on GNOME and KDE/wlroots, plus X11 fallback.

## Upstream findings

Zed PR #4 (in-place image updates) merged at `81c99f816b`. Its history contains
`ffda6ea80a` (dynamic Metal update fencing). Do not reapply the original dynamic
image patch over that merge. Compare remaining local changes individually:
embedded surfaces, tab handling, AppKit pumping, platform window lifecycle, and
shader differences are still present between the local branch and upstream.

GPUix main includes PR #43 primary mouse-up click delivery, nonblocking AppKit
pumping, hot-reload event handling, accessibility props, input fixes, and runtime
error handling. It does not contain our full terminal/CEF surface implementation.
Neither the installed version string `0.7.0` nor merging Zed alone means those
native APIs are present. A stock package replacement is not a safe upgrade.

The native alignment should happen in its own branch: merge the current Zed
baseline, reconcile local surface changes, merge GPUix main, then regenerate the
Heddlework patch and build matching native/React packages. Verify terminal input,
resize, focus traversal, dynamic image updates, CEF lifecycle, and accessibility.
Keep ABI, JS, and declarations from the same artifact. Do not publish a new pin
until those checks pass.

The local installation had reverted to stock GPUix while the patched package
remained in `node_modules/.heddlework-gpuix-0.7`. Restoring the React symlink to
that retained package restores the matching native dependency and declarations.
This is local repair, not a reproducible upstream dependency upgrade; reinstalling
stock dependencies can undo it.

## Community port boundaries

The fork diff is 442 files / approximately 48,000 added lines. Do not merge its
main wholesale. It mixes platform support with product and styling decisions.

Port candidates, in dependency order:

1. Browser placement backoff (`0ee57ea`) and browser-aware window chrome: ported.
2. Protocol types/commands, bounded frame transport, terminal snapshots, and the
   authenticated host. Keep loopback/off defaults; require explicit network enablement.
3. DOM host (`src/dom`), browser aliases/build entry, remote controller, and browser
   lifecycle/reconnect handling. Reuse our UI and theme rather than importing its
   visual redesign. The fork uses a React DOM host, not a WASM-only browser UI.
4. Mobile viewport/keyboard handling, touch/scroll behavior, offline shell caching,
   bounded virtual lists, and optional native iOS transport/client work.
5. Session catalog sharing (`db62554`), lazy restoration (`02b73c6`), snapshot identity
   reuse (`5e1091e`), streaming deltas (`548ba23`), and prepend pagination (`2aa7725`).
   These depend on its host/session architecture; isolated cherry-picks are unsafe.

Exclude theme/font changes, generated artwork, opinionated scheduling/workflow
features, updater/release identities, plugin trust choices, and `.pi` session data.
Preserve source attribution for selected ports.

### Required security review before enabling the host

The inspected fork accepts a token in URLs or a bearer header. Review pairing-token
storage, log/referrer leakage, Origin checks, TLS/network exposure, command validation,
path authorization, reconnect replay, and backpressure before exposing shell/file access.

Its `FrameAssembler` allocates `Array.from({ length: parsed.count })` before bounding
frame count or concurrent pending assemblies. Bound both, plus aggregate bytes and
assembly lifetime. Its `encodeFrames` loop can remain at a 512-byte minimum budget
when an envelope cannot fit; reject impossible frame sizes rather than retry forever.
These are reasons to review/adapt the transport rather than copy it unexamined.

## Linux / Wayland design

GPUI's Wayland backend already implements minimize, maximize/restore (`zoom`),
move with the compositor's mouse-press serial, and decoration negotiation.
GPUix's current JS API does not expose these operations or effective decoration
state. `titlebarTransparent` alone is not a portable client-decoration switch.

Expose capabilities and state from the native UI thread through GPUix:

- Effective server/client decorations, maximized/fullscreen state, and resizability.
- Minimize, maximize/restore, and close through normal window lifecycle handling.
- Begin move/resize from the initiating native pointer press, preserving Wayland serials.

Only show custom controls when client-side decorations are active. Avoid duplicate
buttons on compositors providing server decorations. In fullscreen, respect compositor
state and retain a reachable restore action. Close must run terminal/browser cleanup,
not terminate the process directly. Keep controls out of draggable/resize hit regions.

Use small color/opacity hover and press transitions with reduced-motion support;
do not animate native maximize geometry independently of compositor configure events.
Provide keyboard focus, accessible labels, sufficient hit targets, and accurate restore
icons. GNOME (no server-decoration protocol), KDE/wlroots, fractional scaling, multi-monitor
moves, fullscreen, drag/resize, and XWayland/X11 must be tested explicitly. macOS
headless layout tests cannot establish Wayland correctness.

## Resource policy

No Cargo or CEF rebuild was needed for this first tranche. Reuse retained packages
for local tests. For the native reconciliation, use bounded build profiles and clean
only generated task artifacts after validation; do not delete global caches or run
foreground window automation as part of these checks.
