import { describe, expect, it } from 'bun:test'
import {
  adaptiveOverscanRows,
  adaptiveWindowSize,
  clampVirtualWindowStart,
  countPrependedIds,
  GIANT_MARKDOWN_CHAR_THRESHOLD,
  prependMeasuredHeights,
  reuseRowsById,
  spacerHeight,
  splitMarkdownBlocks,
  TRANSCRIPT_OVERSCAN_ROWS,
  TRANSCRIPT_VIRTUAL_WINDOW_SIZE,
  TRANSCRIPT_VIEWPORT_FALLBACK_PX,
  virtualWindowForTail,
  visibleWindow,
  WEB_TRANSCRIPT_ROW_ESTIMATE_PX,
  WEB_TRANSCRIPT_OVERSCAN,
  webTranscriptWindow,
} from '../src/ui/virtual-window.ts'

describe('virtual window helpers', () => {
  it('pins a tail-aligned window to the newest rows', () => {
    expect(virtualWindowForTail(40, 160)).toBe(0)
    expect(virtualWindowForTail(400, 160)).toBe(240)
    expect(visibleWindow(400, 240, 160)).toEqual({ start: 240, end: 400 })
  })

  it('counts prepended ids without treating a replaced head as a shift', () => {
    expect(countPrependedIds(['a', 'b', 'c'], ['older', 'a', 'b', 'c'])).toBe(1)
    expect(countPrependedIds(['a', 'b'], ['x', 'y'])).toBe(0)
    expect(countPrependedIds(['a', 'b', 'live-old'], ['older', 'a', 'b', 'live-new'])).toBe(1)
    expect(countPrependedIds(['header-old', 'a', 'b'], ['older', 'header-old', 'a', 'header-new'])).toBe(1)
    expect(countPrependedIds(['a', 'b'], ['a', 'b', 'c'])).toBe(0)
    expect(countPrependedIds(undefined, ['a'])).toBe(0)
  })

  it('clamps a scrolled window after history prepends', () => {
    expect(clampVirtualWindowStart(500, 80 + 40, 160)).toBe(120)
    expect(clampVirtualWindowStart(10, 80, 160)).toBe(0)
  })

  it('reuses unchanged row objects by id', () => {
    const previous = [{ id: 'user', text: 'Hi' }, { id: 'live', text: 'Hel' }]
    const next = [{ id: 'user', text: 'Hi' }, { id: 'live', text: 'Hello' }]
    const reused = reuseRowsById(previous, next, (left, right) => left.text === right.text)
    expect(reused[0]).toBe(previous[0])
    expect(reused[1]).toBe(next[1])
    expect(reused[1]).not.toBe(previous[1])
  })

  it('sizes the transcript window to the actual viewport plus modest overscan instead of a fixed 168-row slice', () => {
    const short = adaptiveWindowSize(400, 88)
    const tall = adaptiveWindowSize(8000, 40)
    expect(short).toBeLessThanOrEqual(160)
    expect(tall).toBeGreaterThan(short)
    expect(tall).toBeLessThanOrEqual(TRANSCRIPT_VIRTUAL_WINDOW_SIZE)
    expect(adaptiveOverscanRows(640, 88)).toBeLessThanOrEqual(12)
    expect(adaptiveWindowSize(TRANSCRIPT_VIEWPORT_FALLBACK_PX, 88, TRANSCRIPT_OVERSCAN_ROWS)).toBeLessThan(160)
    expect(adaptiveWindowSize(TRANSCRIPT_VIEWPORT_FALLBACK_PX, 88, TRANSCRIPT_OVERSCAN_ROWS)).toBeGreaterThan(8)
    expect(adaptiveWindowSize(8000, 40)).toBeGreaterThan(160)
    expect(adaptiveWindowSize(8000, 40)).toBeLessThanOrEqual(TRANSCRIPT_VIRTUAL_WINDOW_SIZE)
  })

  it('windows a long web transcript around the viewport, including while following the tail', () => {
    const following = webTranscriptWindow(1_000, 0, 640, true)
    const expected = adaptiveWindowSize(640, WEB_TRANSCRIPT_ROW_ESTIMATE_PX, WEB_TRANSCRIPT_OVERSCAN)
    expect(following.end).toBe(1_000)
    expect(following.end - following.start).toBe(expected)
    expect(following.start).toBe(1_000 - expected)

    const scrolled = webTranscriptWindow(1_000, 72 * 200, 640, false)
    expect(scrolled.start).toBeGreaterThan(150)
    expect(scrolled.start).toBeLessThan(210)
    expect(scrolled.end - scrolled.start).toBe(expected)
    expect(webTranscriptWindow(20, 0, 640, true)).toEqual({ start: 0, end: 20 })
  })

  it('uses measured heights for spacers and keeps them aligned across prepends', () => {
    expect(spacerHeight([40, 80, 0, 20], 0, 3, 72)).toBe(40 + 80 + 72)
    expect(prependMeasuredHeights([10, 20], 2)).toEqual([0, 0, 10, 20])
    const shifted = prependMeasuredHeights([40, 90], 1)
    expect(spacerHeight(shifted, 0, 2, 72)).toBe(72 + 40)
  })

  it('virtualizes giant markdown at block level rather than one row', () => {
    const body = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${'x'.repeat(250)}`).join('\n\n')
    expect(body.length).toBeGreaterThan(GIANT_MARKDOWN_CHAR_THRESHOLD)
    const blocks = splitMarkdownBlocks(body)
    expect(blocks.length).toBe(40)
    expect(blocks.join('')).toBe(body)
  })

  it('keeps 4-backtick fences, reference links, tables, html, lists, and long lines intact', () => {
    const nested = ['intro', '', '````markdown', '```js', 'code()', '```', '````', '', 'outro'].join('\n')
    const nestedBlocks = splitMarkdownBlocks(nested)
    expect(nestedBlocks.join('')).toBe(nested)
    expect(nestedBlocks.some((block) => block.includes('```js') && block.includes('````'))).toBe(true)
    expect(nestedBlocks.some((block) => block.includes('code()') && !block.includes('intro'))).toBe(true)

    const refs = ['See [docs].', '', '[docs]: https://example.com/path', '[other]: https://example.com/other'].join('\n')
    const refBlocks = splitMarkdownBlocks(refs)
    expect(refBlocks.join('')).toBe(refs)
    expect(refBlocks.some((block) => block.includes('[docs]: https://example.com/path'))).toBe(true)

    const table = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '', '<div class="note">', 'kept', '</div>', '', '- one', '- two', '', '1. first', '1. second'].join('\n')
    const tableBlocks = splitMarkdownBlocks(table)
    expect(tableBlocks.join('')).toBe(table)
    expect(tableBlocks.some((block) => block.includes('| 1 | 2 |') && block.includes('| a | b |'))).toBe(true)
    expect(tableBlocks.some((block) => block.includes('<div') && block.includes('kept'))).toBe(true)
    expect(tableBlocks.some((block) => block.includes('- one') && block.includes('- two'))).toBe(true)

    const long = `alpha ${'x'.repeat(12_000)} omega`
    expect(splitMarkdownBlocks(long)).toEqual([long])
  })
})
