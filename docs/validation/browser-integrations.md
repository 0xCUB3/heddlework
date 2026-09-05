# Browser integration validation

## Acceptance checks

- Built-in GPUix panes remain available. External browsing defaults off.
- Aside and custom adapters share one host service across desktop, web, and SwiftUI.
- Profile selection does not execute a task. A review and one-use approval are required.
- Unknown adapters, malformed requests, expired approvals, and replayed approvals are rejected.
- Switching profiles clears pending approval. Restart restores selection, not grants or output.
- Remote clients cannot install or select an arbitrary executable.
- Cancel and timeout report that remote work may continue. Late output cannot revive a stopped task.
- Results enter the chat draft only after the user chooses to copy them. They are not submitted automatically.

## Evidence

The full Bun run passed 423 tests across 92 files. It includes a real custom subprocess, authenticated WebSocket clients, reconnects, and GPUix control clicks. Both TypeScript checks and the production web build passed. The SwiftUI test target passed all 14 tests, including the new wire models and approval commands.

The real Aside adapter completed a public-page-only probe. It opened a new tab at `https://example.com/` and returned **Example Domain**. The task remained in review until approval. The probe did not inspect private sites or account data.

A browser agent exercised Settings → Browser through the production headless entry point with a local fixture adapter. Selection, review, approval, output, copying to an unsent chat draft, clearing, reload, and switching back to built-in all passed. Desktop width was 1440 px. Phone CSS was tested in a 390 × 844 same-origin frame, not a physical device. Neither layout had horizontal document overflow.

A separate sidebar regression verifies that a long first prompt never renders below its title. The rebuilt sidebar uses one 32 px row per title with ellipsis.

No claim is made that Aside account access is a tab sandbox or that local process cancellation stops its remote agent. Those limits are documented and shown in the UI.
