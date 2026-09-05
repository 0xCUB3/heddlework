# Live browser pass

Synthetic loopback demo host. Existing thread `heddlework-ui-parity/hello`. Composer submit of "parity probe" streamed a demo reply.

## Geometry vs GPUix

| Check | GPUix | Web live | Result |
| --- | --- | --- | --- |
| Sidebar | 256 | 256 × 900 at 1440 | match |
| Header | 52 | 52 (1184 desktop, 1024 tablet, 390 phone) | match |
| Content / composer | 768 | 768 desktop and tablet; 370 phone | match (phone is viewport minus 10px gutter) |
| Settings column | 720 | 720 desktop/tablet; 366 phone | match |
| Changes at 1440 | 520 clamped | 520.95, right edge 1440, grid `256 / 663.05 / 520.95` | match after fix |
| Overflow | none | `scrollWidth === clientWidth` on every viewport | match |

Before the CSS fix, Changes painted at **264.95** inside a **520.95** track (`width: 100%` could not resolve, so the panel shrank to "No changes"). `.web-right-panel` now uses `width: auto` plus stretch.

Tablet 1024 and phone 390 hide the docked panel (`display: none`) and use a sheet/drawer. Tablet nav drawer measured **256 × 768**. That is the intended overlay, not a 520 column.

## Interactions

- Existing session opened (already in the main pane).
- Composer input, send, streamed assistant text.
- Settings scrolled to About (`atBottom: true`).
- Light/dark via Settings → Interface.
- Narrow overlay button visible at 1024 and 390; drawer closed with Done.

## Not claimed

Pixel-perfect. Phone/tablet PNGs stayed 1440×900 (Aside screenshot). Use the JSON numbers for those viewports. Native iOS was not rerun; `scripts/validation/ui-parity-native/geometry.json` is still `ok: true` with empty failures.

## Intentional differences

Web is CSS grid. iOS is SwiftUI. ≤1024 is overlay navigation. Host-only actions stay disabled and labeled desktop/host. Demo Changes shows a git error because `/tmp/heddlework-ui-parity` is not a repository.
