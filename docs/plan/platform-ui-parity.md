# Platform UI parity acceptance ledger

The visual and interaction reference is the current main GPUix workbench in `src/ui`, measured through `scripts/validation/gpuix-layout-audit.tsx`. Web uses DOM and iOS uses native SwiftUI. Platform code may change rendering, input, navigation presentation, and operating-system integration. It must not invent a separate reduced companion product.

Older T3 Code captures are historical. Do not treat them as the current authority.

## Required checks

- [x] Desktop, web, and SwiftUI consume the canonical palette and layout contract in `src/workbench/ui-contract.json`.
- [x] Chat, Flows, and Settings remain the primary surfaces. Sessions stay in the sidebar; narrow screens present the sidebar as a drawer.
- [x] Transcript supports user/assistant text, thinking, tool activity, history loading, streaming, and dialog responses.
- [x] Composer supports submission, model and thinking selection, attachments, abort, and queue operations exposed by the host.
- [x] Changes, queue, triage, notifications, and receipts remain reachable without companion-only navigation.
- [x] Settings use the desktop section names and order. Host-only operations explain where they run instead of pretending to execute locally.
- [x] iOS connects directly to the host with URLSession WebSockets. No workspace WKWebView remains in the app path.
- [x] Reconnect, switching hosts, cancellation, and command errors have explicit state. Cleared optional state survives JSON patches.
- [x] GPUix tests and both TypeScript checks pass; web production build succeeds.
- [x] iOS simulator build and native protocol tests pass.
- [x] Inspect rendered desktop, iPhone, and iPad layouts and exercise core interactions. GPUix audit is green. iPhone and iPad UI tests passed against a >1 MiB session. Web layout tests pass. Live browser geometry is in [live-browser findings](../validation/ui-parity/live-browser/findings.md): measured rectangles at 1440/1024/390 light and dark.

## Ownership

Main owns shared contracts, GPUix integration, protocol fixes, and final verification. Platform workers own web and SwiftUI source independently.

## Evidence

See [GPUix acceptance](../validation/ui-parity/gpuix-acceptance.md) for the current matrix, commands, measured geometry, and intentional OS-only adaptations.
