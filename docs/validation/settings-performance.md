# Settings scrolling performance

Settings previously used a generic `overflow: 'scroll'` container. The performance pass moves its long content onto the same GPUix `virtual-list` scroll surface used elsewhere in the native UI.

## Reproduce

Run the native test-renderer harness from the repository root:

```sh
PATH=/Users/skula/.bun/bin:/opt/homebrew/bin:$PATH bun scripts/benchmark-settings-scroll.tsx
```

The harness renders Settings at 900×640, targets the Settings viewport, dispatches 200 sequential synthetic wheel events through GPUix automation, flushes once, and prints elapsed wall time.

To reproduce the pre-change number, create a separate worktree at baseline `429cee9`, copy `scripts/benchmark-settings-scroll.tsx` into that worktree, and run the same command there. Do not switch/reset a working tree containing active changes.

## Result

| Version | 200 synthetic wheel events |
| --- | ---: |
| Baseline `429cee9` generic overflow scroller | 1361.1 ms |
| Native `virtual-list` scroller | 879.2 ms |

That is about a 35% reduction in this like-for-like dispatch benchmark on the development Mac. Earlier exploratory runs were ~1349 ms baseline and ~828 ms modified; individual runs vary with machine load.

This is not an FPS or frame-time guarantee. The benchmark measures 200 serialized synthetic wheel-event dispatches through the native test renderer; it does not measure display refresh cadence, compositor stalls, trackpad coalescing, or end-to-end rendered frame latency. Instruments/Core Animation remains the appropriate check for sustained interactive frame rate.

## Web path

The web build uses the same `NativeVirtualList` intrinsic. `src/dom/host.tsx` maps `virtual-list` to `DomVirtualList`, whose scroller uses `overflow-y: auto` and handles wheel events. The existing regression can be run with:

```sh
PATH=/Users/skula/.bun/bin:/opt/homebrew/bin:$PATH bun test tests/dom-virtual-list-wheel.test.tsx
```

It verifies that wheel input reaches the shared DOM virtual-list shim and re-reports the visible range even when the browser scroller itself cannot move.
