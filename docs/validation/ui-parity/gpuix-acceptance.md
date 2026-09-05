# GPUix acceptance matrix

Authority is the current main workbench in `src/ui`, measured by `scripts/validation/gpuix-layout-audit.tsx`. T3 captures in this folder are historical.

## Commands

- GPUix geometry: `bun scripts/validation/gpuix-layout-audit.tsx`
- Token lock: `bun test tests/gpuix-layout-tokens.test.ts`
- Web layout: `bun test tests/web-layout-parity.test.ts tests/web-workbench-layout.test.ts`
- Phone QR: `bun test tests/web-qr.test.ts tests/phone-pairing.test.tsx`
- iOS protocol: `xcodebuild test -project packaging/ios/Heddlework.xcodeproj -scheme Heddlework -only-testing:HeddleworkTests`
- iOS UI: `xcodebuild test ... -only-testing:HeddleworkUITests` with `TEST_RUNNER_CONNECT_URL` for a live host

## Recovery evidence (2026-09-05)

- GPUix audit wrote `scripts/validation/ui-parity-native/geometry.json` with `"ok": true` and an empty failure list.
- Native QR screenshot decoded to `http://192.168.1.20:4817/?token=phone-link-token` via Vision. The painted image is a PNG, not nested module boxes.
- URLSession received a welcome larger than 1 MiB. Framed assembly of a 1.2 MiB welcome also passed. Decode stays off the main thread.
- iPhone and iPad UI tests found `connect-link` after `HEEDLEWORK_RESET_CONNECTION=1`. A live 1.2 MiB session opened without "Message too long". Composer appeared; sidebar toggle stayed under 2 s.
- Web layout and token tests passed. A live browser pass on a loopback demo host measured sidebar 256, header 52, composer 768, settings 720, and Changes 520.95 at 1440 after fixing `.web-right-panel` self-sizing (was 264.95 in a 520.95 track). Tablet 1024 and phone 390 use overlay drawers; docked Changes is hidden. Phone and tablet screenshot files were not viewport-true, so those sizes are recorded as getBoundingClientRect in [live-browser findings](live-browser/findings.md).

## Intentional OS-only adaptations

- Web uses DOM and CSS grid. iOS uses SwiftUI and URLSession. Both consume `src/workbench/ui-contract.json`.
- At ≤1024 CSS pixels, web hides the docked sidebar and Changes column and uses overlay drawers/sheets. Native iPad 1180 still docks a clamped Changes column (420).
- iOS truncates transcript bubbles above 16,384 characters so a huge historical message cannot freeze layout.
- Phone QR is shown only for a Tailscale or LAN address, never loopback.
