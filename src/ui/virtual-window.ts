export const DEFAULT_VIRTUAL_WINDOW_SIZE = 160
export const TRANSCRIPT_VIRTUAL_WINDOW_SIZE = 320
export const TRANSCRIPT_OVERSCAN_ROWS = 6
export const TRANSCRIPT_VIEWPORT_FALLBACK_PX = 640
export const GIANT_MARKDOWN_CHAR_THRESHOLD = 8_000
export const SIDEBAR_VIRTUAL_WINDOW_SIZE = 80
export const WEB_TRANSCRIPT_WINDOW_SIZE = 80
export const WEB_TRANSCRIPT_ROW_ESTIMATE_PX = 72
export const WEB_TRANSCRIPT_OVERSCAN = 10

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const ATX_HEADING = /^ {0,3}#{1,6}(?:\s|$)/
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/
const BULLET_LIST = /^ {0,3}[-*+](?:\s|$)/
const ORDERED_LIST = /^ {0,3}\d{1,9}[.)](?:\s|$)/
const REFERENCE_DEF = /^ {0,3}\[[^\]\n]{1,999}\]:/
const HTML_BLOCK = /^ {0,3}<\/?([A-Za-z][\w:-]*)\b/
const HTML_BLOCK_TAGS = new Set([
  'address', 'article', 'aside', 'base', 'basefont', 'blockquote', 'body',
  'caption', 'center', 'col', 'colgroup', 'dd', 'details', 'dialog', 'dir',
  'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'frame', 'frameset', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header',
  'hr', 'html', 'iframe', 'legend', 'li', 'link', 'main', 'menu', 'menuitem',
  'nav', 'noframes', 'ol', 'optgroup', 'option', 'p', 'param', 'pre', 'script',
  'section', 'source', 'style', 'summary', 'table', 'tbody', 'td', 'tfoot',
  'th', 'thead', 'title', 'tr', 'track', 'ul',
])
const TABLE_DIVIDER = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?\s*$/

export function adaptiveOverscanRows(viewportHeight: number, estimatedRowHeight: number): number {
  const visible = Math.max(1, Math.ceil(Math.max(1, viewportHeight) / Math.max(1, estimatedRowHeight)))
  return Math.min(12, Math.max(2, Math.ceil(visible * 0.5)))
}

export function adaptiveWindowSize(
  viewportHeight: number,
  estimatedRowHeight: number,
  overscan?: number,
  maxWindow = TRANSCRIPT_VIRTUAL_WINDOW_SIZE,
): number {
  const visible = Math.max(1, Math.ceil(Math.max(1, viewportHeight) / Math.max(1, estimatedRowHeight)))
  const extra = overscan ?? adaptiveOverscanRows(viewportHeight, estimatedRowHeight)
  const sized = visible + Math.max(0, extra) * 2
  return Math.max(1, Math.min(maxWindow, sized))
}

export function clampVirtualWindowStart(itemCount: number, start: number, windowSize: number): number {
  const maxStart = Math.max(0, itemCount - windowSize)
  return Math.max(0, Math.min(maxStart, start))
}

export function virtualWindowForTail(itemCount: number, windowSize: number): number {
  return Math.max(0, itemCount - windowSize)
}

export function countPrependedIds(previous: readonly string[] | undefined, next: readonly string[]): number {
  const oldFirst = previous?.[0]
  if (!oldFirst || previous === next) return 0
  const index = next.indexOf(oldFirst)
  return index > 0 ? index : 0
}

export function visibleWindow(
  itemCount: number,
  start: number,
  windowSize: number,
): { start: number; end: number } {
  const windowStart = clampVirtualWindowStart(itemCount, start, windowSize)
  return { start: windowStart, end: Math.min(itemCount, windowStart + windowSize) }
}

export function webTranscriptWindow(
  itemCount: number,
  scrollTop: number,
  viewportHeight: number,
  followTail: boolean,
  windowSize = WEB_TRANSCRIPT_WINDOW_SIZE,
  estimatePx = WEB_TRANSCRIPT_ROW_ESTIMATE_PX,
  overscan = WEB_TRANSCRIPT_OVERSCAN,
): { start: number; end: number } {
  const size = adaptiveWindowSize(viewportHeight, estimatePx, overscan, Math.max(windowSize, TRANSCRIPT_VIRTUAL_WINDOW_SIZE))
  if (itemCount <= size) return { start: 0, end: itemCount }
  if (followTail) return visibleWindow(itemCount, virtualWindowForTail(itemCount, size), size)
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / Math.max(1, estimatePx)) - overscan)
  return visibleWindow(itemCount, first, size)
}

export function spacerHeight(heights: readonly number[], start: number, end: number, fallback: number): number {
  let total = 0
  for (let index = start; index < end; index += 1) {
    const height = heights[index]
    total += height && height > 0 ? height : fallback
  }
  return total
}

export function prependMeasuredHeights(heights: readonly number[], prepended: number): number[] {
  if (prepended <= 0) return heights.slice()
  const next = new Array<number>(prepended + heights.length)
  next.fill(0, 0, prepended)
  for (let index = 0; index < heights.length; index += 1) next[prepended + index] = heights[index] ?? 0
  return next
}

export function recordMeasuredHeight(heights: number[], index: number, height: number): void {
  if (index < 0 || height <= 0) return
  while (heights.length <= index) heights.push(0)
  heights[index] = height
}

export function averageMeasuredHeight(heights: readonly number[], fallback: number): number {
  let total = 0
  let count = 0
  for (const height of heights) {
    if (height > 0) {
      total += height
      count += 1
    }
  }
  return count > 0 ? total / count : fallback
}

export function splitMarkdownBlocks(source: string): string[] {
  const text = source.replace(/\r\n/g, '\n')
  if (!text) return ['']
  const ranges = markdownBlockRanges(text)
  if (ranges.length === 0) return [text]
  return ranges.map((range) => text.slice(range.start, range.end))
}

function markdownBlockRanges(text: string): Array<{ start: number; end: number }> {
  const lines = lineOffsets(text)
  const ranges: Array<{ start: number; end: number }> = []
  let cursor = 0
  let index = 0
  while (cursor < text.length && index < lines.length) {
    while (index < lines.length && !lines[index]!.text.trim()) index += 1
    if (index >= lines.length) {
      ranges.push({ start: cursor, end: text.length })
      break
    }
    index = consumeMarkdownBlock(lines, index)
    const end = index < lines.length ? lines[index]!.start : text.length
    ranges.push({ start: cursor, end })
    cursor = end
  }
  if (ranges.length === 0) return [{ start: 0, end: text.length }]
  ranges[ranges.length - 1]!.end = text.length
  return ranges
}

function lineOffsets(text: string): Array<{ start: number; end: number; text: string }> {
  const lines: Array<{ start: number; end: number; text: string }> = []
  let start = 0
  for (let index = 0; index <= text.length; index += 1) {
    if (index === text.length || text[index] === '\n') {
      lines.push({ start, end: index + (index === text.length ? 0 : 1), text: text.slice(start, index) })
      start = index + 1
    }
  }
  return lines
}

function consumeMarkdownBlock(lines: Array<{ text: string }>, index: number): number {
  const line = lines[index]!.text
  const fence = FENCE_OPEN.exec(line)
  if (fence) return consumeFence(lines, index, fence[1]!)
  if (HTML_BLOCK.test(line) && isHtmlBlockTag(line)) return consumeHtml(lines, index)
  if (REFERENCE_DEF.test(line)) return consumeReferenceDefs(lines, index)
  if (isTableStart(lines, index)) return consumeTable(lines, index)
  if (BULLET_LIST.test(line) || ORDERED_LIST.test(line)) return consumeList(lines, index)
  if (ATX_HEADING.test(line) || THEMATIC_BREAK.test(line)) return index + 1
  return consumeParagraph(lines, index)
}

function consumeFence(lines: Array<{ text: string }>, index: number, opener: string): number {
  const marker = opener[0]!
  const min = opener.length
  let cursor = index + 1
  while (cursor < lines.length) {
    const close = FENCE_CLOSE.exec(lines[cursor]!.text)
    if (close && close[1]![0] === marker && close[1]!.length >= min) return cursor + 1
    cursor += 1
  }
  return lines.length
}

function isHtmlBlockTag(line: string): boolean {
  const match = HTML_BLOCK.exec(line)
  return Boolean(match && HTML_BLOCK_TAGS.has(match[1]!.toLowerCase()))
}

function consumeHtml(lines: Array<{ text: string }>, index: number): number {
  const match = HTML_BLOCK.exec(lines[index]!.text)
  const tag = match?.[1]?.toLowerCase()
  let cursor = index + 1
  while (cursor < lines.length) {
    const current = lines[cursor]!.text
    if (tag && new RegExp(`^ {0,3}</${tag}>`, 'i').test(current)) return cursor + 1
    if (!current.trim()) return cursor + 1
    cursor += 1
  }
  return lines.length
}

function consumeReferenceDefs(lines: Array<{ text: string }>, index: number): number {
  let cursor = index + 1
  while (cursor < lines.length && REFERENCE_DEF.test(lines[cursor]!.text)) cursor += 1
  return cursor
}

function isTableStart(lines: Array<{ text: string }>, index: number): boolean {
  const line = lines[index]?.text
  const divider = lines[index + 1]?.text
  return Boolean(line && divider && line.includes('|') && TABLE_DIVIDER.test(divider))
}

function consumeTable(lines: Array<{ text: string }>, index: number): number {
  let cursor = index + 2
  while (cursor < lines.length && lines[cursor]!.text.includes('|') && lines[cursor]!.text.trim()) cursor += 1
  return cursor
}

function consumeList(lines: Array<{ text: string }>, index: number): number {
  const ordered = ORDERED_LIST.test(lines[index]!.text)
  let cursor = index + 1
  while (cursor < lines.length) {
    const current = lines[cursor]!.text
    if (!current.trim()) {
      const next = lines[cursor + 1]?.text ?? ''
      if (next.startsWith(' ') || next.startsWith('\t') || (ordered ? ORDERED_LIST.test(next) : BULLET_LIST.test(next))) {
        cursor += 1
        continue
      }
      break
    }
    if (current.startsWith(' ') || current.startsWith('\t')) {
      cursor += 1
      continue
    }
    if (ordered ? ORDERED_LIST.test(current) : BULLET_LIST.test(current)) {
      cursor += 1
      continue
    }
    break
  }
  return cursor
}

function consumeParagraph(lines: Array<{ text: string }>, index: number): number {
  let cursor = index + 1
  while (cursor < lines.length) {
    const current = lines[cursor]!.text
    if (!current.trim()) break
    if (FENCE_OPEN.test(current) || ATX_HEADING.test(current) || THEMATIC_BREAK.test(current)) break
    if (BULLET_LIST.test(current) || ORDERED_LIST.test(current) || REFERENCE_DEF.test(current)) break
    if (current.trimStart().startsWith('>') || isHtmlBlockTag(current) || isTableStart(lines, cursor)) break
    cursor += 1
  }
  return cursor
}

export function advertisedDisplayRefreshHz(): number | undefined {
  const raw = typeof process !== 'undefined' ? process.env.HEDDLEWORK_DISPLAY_HZ : undefined
  if (!raw) return undefined
  const hz = Number(raw)
  if (!Number.isFinite(hz) || hz < 30 || hz > 360) return undefined
  return hz
}

export function fallbackFrameIntervalMs(): number {
  const hz = advertisedDisplayRefreshHz()
  return hz ? 1000 / hz : 16.67
}

export function scheduleAnimationFrame(callback: () => void): () => void {
  const raf = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame
    : (next: FrameRequestCallback) => setTimeout(next, fallbackFrameIntervalMs()) as unknown as number
  const cancel = typeof cancelAnimationFrame === 'function'
    ? cancelAnimationFrame
    : (id: number) => clearTimeout(id)
  const id = raf(callback)
  return () => cancel(id)
}

export function reuseRowsById<T extends { id: string }>(
  previous: readonly T[],
  next: readonly T[],
  equal: (left: T, right: T) => boolean,
): T[] {
  if (previous.length === 0 || previous === next) return next.slice()
  const prevById = new Map(previous.map((row) => [row.id, row]))
  return next.map((row) => {
    const old = prevById.get(row.id)
    return old && equal(old, row) ? old : row
  })
}
