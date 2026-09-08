# Scroll, rendering, and session correctness — 2026-09-08

This pass starts from the existing, uncommitted responsiveness work on `main` at
`d55e9ad`. It does not replace that work. The starting patch, source snapshot,
before/after test logs, and native screenshots are retained locally under
`~/.cache/heddlework-scroll-fix.6OYK7K/`.

## Research and implementation constraints

Primary references, checked against the pinned GPUix 0.7 checkout rather than
assuming that current upstream APIs match the bundled build:

- [GPUix: lists, scroll anchoring, tail following, and performance](https://github.com/remorses/gpuix#virtual-lists): use direct list children as virtualization units; retain logical row identity and measured heights; a height estimate is not a fixed row height; include native layout/paint in performance measurements.
- [React: custom memo comparison](https://react.dev/reference/react/memo#specifying-a-custom-comparison-function): callback changes matter because functions close over parent state. A comparator must not hide them.
- Pinned native implementation: `packages/native/src/renderer.rs` and
  `zed/crates/gpui/src/elements/list.rs` in `../gpuix-heddlework-0.7`.
  Font size and line height use floating-point logical pixels. Blanket rounding
  of text metrics is not an appropriate substitute for fixing layout bounds.

The intended scroll contract is explicit: reading older content survives a
stream starting, theme changes, and history prepends. Any upward movement pauses
tail following; movement back to the actual bottom resumes it. Merely showing
part of the last row must not snap the viewport.

## Reproduced defects and corrections

### Native list and viewport state

The native renderer recreated `ListState` when item count, height estimate,
overdraw, or follow mode changed. That discarded measured height metadata.
Compatible mutations now update the existing state; count changes use splices
when overlapping row identities establish whether the mutation is at the front
or back. Ambiguous structural changes retain a conservative fallback. Overdraw
has a small GPUI setter rather than a state reset. Changes are carried in
`patches/gpuix-0.7.0-heddlework.patch`, not just in an external checkout.
Only newly inserted external rows receive new estimate hints; count changes do
not rewrite every existing hint. In-place reconciliation also drops unmounted
host IDs from the seen-row set, preventing growth across repeated window remounts.

The native regression checks both the retained row's painted position and its
logical anchor. Estimated absolute scroll offsets can legitimately change when
previously unmeasured heights change; that number alone is not proof of a visible
jump. For unchanged estimates, the regression also checks preservation of cached
height metadata.

The React window hook replayed a prepend on its own render-time state updates:
start 20 plus two prepended rows became 62 instead of 22. It now consumes a
count transition once. Old-session range callbacks are ignored, while callbacks
retained within the current session use current window geometry.

DOM virtualization incorrectly interpreted an append plus a normal window move
as a prepend, changing a measured 40px spacer to an estimated 72px spacer. Height
migration now follows overlapping row keys. Scheduled range reports for an old
window are canceled. Exact bottom status participates in range deduplication.

### Settings layout and culling

Settings supplied one giant native list item, preventing section-level culling.
Sections now form separate centered list rows. An isolated native fixture painted
all 60 rows in the grouped case versus eight in the sectioned case. This is a
culling check, not a claim of a corresponding frame-rate multiplier.

Native screenshots exposed missing narrow-screen gutters and row border
refinement leaking into rounded card edges. Layout checks use actual bounds and
painted content; tests scroll offscreen controls into view before interacting.
Screenshots cover narrow and wide layouts, not every device or display scale.

### Transcript races and stale rendering

- Callback-only replacements were hidden by `React.memo`, so revert could call
  the old handler. The comparator now observes callbacks; the app supplies stable
  callbacks to avoid turning correctness into unnecessary rerendering.
- Theme changes remounted the entire list. Its identity now depends on the
  session, not appearance.
- Same-count image updates and usage-only updates were treated as unchanged.
  Comparisons include displayed data. Giant Markdown caches store parsed blocks,
  not stale message metadata.
- Asynchronous image preparation was rejected after the first message-array
  replacement. Adoption is now guarded by cancellation. The cache verifies source
  content and preserves current metadata; mixed cached/uncached visible batches
  adopt both kinds of results.
- History locks were cleared by unrelated message updates and old-session
  completions. Request-owned tokens prevent both interleavings.
- Automatic detail prefetch started two new requests on each rerender rather
  than enforcing two total in flight. It now accounts for outstanding requests,
  advances as slots free, and does not repeatedly fetch a successfully attempted
  stub. Session generations guard deferred invocation and completion.
- Starting a stream could steal a historical reading position. Downward wheel
  events also disabled following, while tiny upward events did not. Tests now
  cover all three cases and returning to the exact bottom.

Visible-row ID arrays retain identity when only content changes, avoiding
needless image/preload cancellation. Removed unused trace height estimation and
formatting helpers. Row execution instrumentation is opt-in rather than an
unbounded production map. Correctness guards and regression tests are retained
even where they add lines.

### Remote and host session races

Detail request deduplication now includes the requested byte limit. Preview
history loads validate navigation ownership both before reading and before
publishing. Rekeying an execution lease carries its last-used timestamp so idle
cleanup still works. Remote new-session/workspace/clone navigation no longer
keeps a stale selected-file pin, and failed switches do not silently retry when
an unrelated snapshot arrives. Disposal cancels pending editor debounce work.
Editor drafts are session-keyed: typing while a selection is pending, switching
again, or submitting before the debounce expires cannot send that draft to the
wrong session. Dispatch checks ownership after waiting for selection, not just
when a timer starts. New-session navigation clears the visible old draft while
preserving the old session's local draft.

## Upstream integration

Merged `monotykamary/heddlework` main at `8fce604` using merge commit `b473481`
(parents `d55e9ad` and `8fce604`). The merge was resolved in an isolated worktree,
then its delta was three-way combined with the dirty working tree. The existing
work and this pass's fixes remain unstaged; they were not folded into the merge
commit. No push was performed.

Adopted compact browser chrome, equal-width surface cards, browser-aware window
chrome, the platform-alignment document, attribution, and upstream regression
tests. Preserved fork-specific UI contracts, memoization, resize behavior, and
equivalent traffic-light inset helpers. The fork already contained upstream's
browser placement polling/backoff behavior. The one conflict with uncommitted
work combined browser-aware Settings chrome with the new section-level gutters.

## Reproducible native build

The selected Xcode 27 beta linker produced a native addon that `dlopen` rejected
with a misaligned LINKEDIT string pool. The stable Xcode installation lacked its
own Metal toolchain. A scoped build uses the stable host compiler/linker and the
already-installed Metal tools without changing `xcode-select` or app preferences:

```sh
DEVELOPER_DIR=/Applications/Xcode-26.6.0.app/Contents/Developer \
GPUIX_METAL_DEVELOPER_DIR=/Applications/Xcode-27.0.0-Beta.5.app/Contents/Developer \
bun run gpuix:build
```

`scripts/build-gpuix.sh` supports that optional Metal-only override and verifies
addon loadability before packaging. It still builds `test-support` and
`native-browser-cef`; it does not substitute a test-only build. The offscreen test
renderer deliberately reports browser support as unavailable, and the real
renderer reports availability only after initialization, so neither flag before
initialization proves that Chromium was omitted. Packaged browser smoke is the
runtime check.

The build script now also distinguishes an already-applied patch from a patch
conflict: it refuses to build the latter rather than silently shipping an
unpatched renderer.

The locally rebuilt `.3` tarball differs from the published prebuilt archive.
During this run, `bun install --force` silently reused the older cached addon;
a fresh-cache frozen install correctly rejected the old lockfile integrity.
Only the native archive's SHA-512 in `bun.lock` was refreshed from the locally
built bytes. No unrelated package version or integrity changed. A fresh-cache
`bun install --force --frozen-lockfile` then succeeded, and the installed addon,
framework build, and CEF manifest all matched this SHA-256:

```text
a0c109a71d5d25bad551c089a808c01c325baf8e69783f4502626d80539f368b
```

For subsequent local rebuilds, update the lock integrity from the rebuilt local
archives and verify the installed addon hash, not just the package version.
Fetching the published prebuilt `.3` archive does not reproduce these new native
fixes; use the source build and the matching local archives/checksums. Publishing
a new versioned GPUix release was not part of this run.

## Validation record

The first eight new transcript checks all failed before their fixes. Separate
checks reproduced the history-lock, repeated-prefetch, and tail-follow defects
before correction. Tests use disposable fixtures and native offscreen windows;
they do not send prompts to real models or mutate active Pi sessions.

The first integration run completed 827 tests: 823 passed, two failed, and two
real-Pi opt-in tests were skipped. The failures exposed a remaining native
follow-mode cache reset and an old UI test that assumed offscreen Settings
sections were painted. This intermediate run is preserved in
`full-suite-first.log`; it is not the final validation result.

### Final source and native validation

- `bun run typecheck` and `bun run typecheck:web`: passed.
- `bun test`: **835 passed, 2 skipped, 0 failed**, 5,554 assertions across
  168 files, 95.49 seconds (`full-suite-final.log`). The skips are the two
  opt-in real-Pi integration tests; no model prompts were sent.
- Native anchor regression: all four cases passed against the final rebuilt
  addon (`native-anchors-final.log`). The retained row's painted Y did not move
  on append, overdraw change, estimate change, or prepend. Prepend advances the
  logical index by one while leaving the visible row fixed.
- Fresh-cache frozen dependency install passed; native binary and CEF manifest
  hashes were verified, not inferred from the unchanged package version.
- Native/Zed persistent patch reverse-application checks and shell syntax check
  passed. Full-suite React `act` warnings remain in pre-existing UI test paths;
  the tests pass, and the warnings were not suppressed.

### Native timing measurements

`bun scripts/benchmark-responsiveness-native.tsx` ran sequentially, with no other
benchmark or build running, using the final installed native dependency. The
fixture viewport is 900×640 logical pixels; each case issues 100 synthetic wheel
events followed by explicit native flushes. Every case painted its initial tail
and ended with 16 mounted transcript rows.

| Conversation fixture | Median wheel + flush | p95 | Maximum |
| --- | ---: | ---: | ---: |
| 40 plain-text turns | 2.78 ms | 3.29 ms | 4.40 ms |
| 160 plain-text turns | 3.02 ms | 3.89 ms | 4.94 ms |
| 1,000 plain-text turns | 4.88 ms | 5.98 ms | 9.06 ms |
| 40 rich-Markdown turns | 5.32 ms | 11.16 ms | 17.76 ms |
| 160 rich-Markdown turns | 4.44 ms | 8.65 ms | 10.65 ms |

Raw results: `native-benchmark-final.json`. These are offscreen synthetic timings,
not display FPS or end-to-end physical trackpad-to-display latency. The rich-text
fixture still has a 17.76 ms worst sample; the result is not a guarantee of a
perfect frame budget. Streaming samples in that script measure immediate React
commits, not all subsequent throttled Markdown effects.

Narrow and wide Settings screenshots were reviewed for gutters, centering,
wrapping, and card corners (`settings-narrow-final.png`,
`settings-wide-final.png`). That is not exhaustive visual validation across all
display scales, themes, platforms, or content.

### Deployment and packaged runtime

`bun scripts/install-dev.ts --no-launch` completed successfully on this Mac and
`mbp2` (`install-dev-final.log`). Both background runtimes reported ready at
version 0.1.4, protocol 2. No normal GUI was launched. SHA-256 verification over
SSH confirmed the installed GUI and runtime executables are byte-identical on
the two Macs:

```text
GUI      a57ffc5e7fd43b8d3a8798125612f730c633465bcdd21ce44308603dc34cd65d
Runtime  4bd37be4ed1e345179655267b0c0384e93cf863728e71a6876e756d0e9774378
```

The installed Dev bundle then passed `scripts/smoke-browser.ts` using
`HEDDLEWORK_SMOKE_APP` to select that exact bundle. The harness supports the Dev
helper names and isolates HOME, workspace, and browser profiles in its temporary
directory. The app's smoke mode sets `focus: false, show: false`.
`browser-smoke-final.log` reports eight local HTTP requests, isolated profiles,
FIFO commands, sandboxed helpers, tab/CEF Views teardown, and clean shutdown.
The smoke process left no running GUI behind.

Final `git diff --check` passed; the index has no staged WIP and upstream/main is
an ancestor of HEAD `b473481`. Existing uncommitted work remains intact and no
push was performed. Native binary validation and installation cover macOS arm64;
Windows, Linux, and iOS native builds were not run. This audit does not establish
the absence of every possible race or visual defect.
