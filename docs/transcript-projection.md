# Transcript projection

The transcript has four separate concerns:

1. `PiSessionHistoryPager` reads bounded chunks from disk. Those chunks are an I/O detail, not presentation pages.
2. `buildTimeline` turns Pi messages into semantic user, assistant, reasoning, context, and tool items.
3. `groupWorkItems` and `projectTranscriptRows` decide which semantic rows currently exist.
4. GPUIX owns scroll position, row measurement, layout, and paint.

Keeping these seams separate prevents data loading, disclosure state, and scroll anchoring from correcting one another with pixel offsets.

## Native row invariant

A GPUIX virtual-list row is one direct host child. Every projected message, trace header, reasoning disclosure, context injection, tool call, changed-files card, and spacer is therefore a direct keyed child of the transcript list.

An expanded execution trace must never contain its entire timeline as nested descendants of one row. A giant row forces GPUIX to lay out and paint the whole chain on every wheel frame, even though the outer list is virtualized.

The transcript deliberately uses keyed children mode. GPUIX still constructs, lays out, and paints only visible rows plus overdraw, while React retains the lightweight projected rows. More importantly, keyed splices preserve measured row identity and the reader's exact position when history prepends. Dynamic `itemCount` changes currently require application-owned anchor correction and discard the measured-key guarantee needed by reverse history.

## Progressive disclosure

Collapsed traces project one header and, when applicable, one changed-files row. Opening a trace immediately projects at most 48 semantic entries. Remaining entries are represented by one lightweight continuation row and materialize in 48-row chunks, one global chunk every 16 ms.

This makes the first disclosure frame bounded without turning trace expansion into a user-visible pagination control. Every materialized entry has its final stable key, so adding later chunks cannot move content already under the reader.

Reasoning and tool bodies have controlled disclosure state owned above the row components. Scrolling a native row out of view or collapsing and reopening its trace therefore does not lose explicit expansion state.

## Scroll ownership

There is one bottom-aligned native virtual list for every transcript size and lifecycle state.

- Settled sessions start at the newest content but do not follow row-height changes.
- Streaming sessions enable native `followTail`; GPUIX stops following when the reader scrolls away.
- Loading older history is intentionally paintless; retained keyed content stays visible until the prepend commits.
- `onVisibleRange` requests older disk data before the loaded boundary is exposed.
- If a disk chunk only extends an already collapsed first trace and adds no scrollable row, bounded continuation reads through it until semantic history appears.
- Prepending semantic rows relies on stable keys and native measured anchoring, not `scrollTo` restoration.

Programmatic `scrollToItem` is reserved for disclosure: if expanding a short bottom-aligned transcript would place the clicked header outside the viewport, it reveals that same keyed row. It is a no-op when the row remains visible.

## Acceptance invariants

- A retained visible message keeps the same native identity and y coordinate across a history prepend.
- Loading cannot change list child indices or scroll geometry.
- A failed or very long trace remains collapsed until explicitly opened.
- Opening 256 tools projects fewer than 80 rows in the first frame.
- Expanded tools are independent native rows and twenty wheel frames stay below the giant-row regression budget.
- Background projection eventually exposes every trace entry without user action.
