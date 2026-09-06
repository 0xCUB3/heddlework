# Historical T3 Code visual comparison

Current parity is measured against the main GPUix workbench in `src/ui`. See [GPUix acceptance](gpuix-acceptance.md) for the live matrix and commands. The T3 captures below are a historical record of an earlier visual target. They are not the authority for new layout work.

## Reference

The historical reference was the real T3 Code web app, not a marketing image. We ran `t3 v0.0.38` on a separate loopback port with isolated storage. Source inspection used `pingdotgg/t3code` commit `761d4bac1c238ea7af4dd36b56719ad5e30771c3`. The installed release and source checkout are recorded separately; they are not assumed to be the same revision.

Captures use a 1440 × 900 desktop viewport and a 390 × 844 phone viewport. The project name is `heddlework-ui-parity`. No provider agents ran in T3 Code.

## Before

The old web client did not match T3. It had a darker sidebar, tab-like navigation, a panel open by default, and a composer below the phone viewport. These captures show that state, not the final implementation. They show an active conversation; the T3 captures show a new thread, so a whole-image pixel score would not be a valid comparison.

| Desktop before | T3 desktop reference |
| --- | --- |
| ![Old Heddlework web](before-desktop.png) | ![T3 new thread](t3-desktop.png) |

| Phone before | T3 phone reference |
| --- | --- |
| ![Old Heddlework phone](before-phone.png) | ![T3 phone new thread](t3-phone.png) |

## Measured targets

| Element | T3 reference |
| --- | --- |
| Sidebar | 256 px including divider |
| Header | 52 px; no bottom border in the thread view |
| Canvas | `#FDFDFD` |
| Sidebar surface | `#FAFAFA`, with a grain texture |
| Divider | `#E4E4E7` |
| Font | System sans-serif stack |
| Base text | 16 px / 24 px |
| Composer text | 14 px / 22.75 px |
| Desktop new-thread composer | x 464, y 394, width 768, height 144 px |
| Composer outer radius | 22 px |
| Desktop send control | 32 px circle |
| Phone new-thread composer | x 12, y 370, width 366, height 140 px |

Heddlework keeps its name, icon, Pi models, and host-backed actions. It must not offer dummy Codex permissions or Git actions just to fill a screenshot. Queue and other Heddlework controls must remain reachable without changing the main composer layout.

## After

| T3 desktop | Heddlework desktop |
| --- | --- |
| ![T3 desktop](t3-desktop.png) | ![Heddlework desktop](after-desktop.png) |

| T3 phone | Heddlework phone |
| --- | --- |
| ![T3 phone](t3-phone.png) | ![Heddlework phone](after-phone.png) |

| T3 settings | Heddlework settings |
| --- | --- |
| ![T3 settings](t3-settings.png) | ![Heddlework settings](settings-desktop.png) |

## Verified behavior

- The visible composer surface matches the measured rectangle at both reference sizes: desktop `464,394,768,144`; phone `12,370,366,140`.
- Desktop hero typography matches the measured 30 px size, 36 px line height, and −0.75 px letter spacing.
- The sidebar is 256 px wide and the header is 52 px tall.
- No horizontal document scroll at 1440 × 900, 1440 × 500, 390 × 844, or 390 × 500.
- Settings scrolls in a 500 px tall desktop window. Disconnect remains reachable. See [the short-window capture](settings-short-desktop.png).
- Two consecutive prompts each render their final answer without a third prompt. The demo transport now publishes independent history arrays; mutation had hidden the newest answer from snapshot diffs.
- Browser probes exercised the model picker, phone thinking selection, queue submission, and panel closing.
- Settings replaces the main sidebar with section navigation. Phone navigation uses a left drawer.
- Dark mode and short-phone composer visibility were inspected.

## Test evidence

- Both TypeScript checks and the production web build passed.
- The final web suite passed: 19 tests across 11 files.
- The full Bun run after the demo fix covered 412 tests: 409 passed and three exposed old synchronous-history assumptions. Those three waits now require final history. The affected controller, composition, host, and consecutive-turn suites then passed: 7 tests, 54 assertions. No failed assertion was removed.
- Shared palette, terminal theme, snapshot deletion, and web build-hash checks passed: 17 tests.
- Native SwiftUI build and tests passed: 12 tests, zero failures. The final tablet toolbar-only edit also compiled.
- The iPhone and iPad connected to the same demo host. Native captures: [iPhone](native-iphone.png), [iPad](native-ipad.png). The workspace uses SwiftUI and URLSession WebSockets, not WKWebView.

## Scope of the visual claim

The measured geometry matches; a whole-app pixel-perfect match is not established. Branding, model names, available actions, and settings content differ by design. Native controls retain SwiftUI behavior. No whole-image pixel score is reported across different content.

The macOS GUI harness could not start because of broken installed dependencies. Native validation therefore covers simulator launches, live snapshots, screenshots, builds, and protocol tests—not a complete tap-through of every native control. No global packages were changed.
