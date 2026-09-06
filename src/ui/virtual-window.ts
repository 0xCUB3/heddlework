export const DEFAULT_VIRTUAL_WINDOW_SIZE = 160
export const TRANSCRIPT_VIRTUAL_WINDOW_SIZE = 320
export const SIDEBAR_VIRTUAL_WINDOW_SIZE = 80
export const WEB_TRANSCRIPT_WINDOW_SIZE = 80
export const WEB_TRANSCRIPT_ROW_ESTIMATE_PX = 72
export const WEB_TRANSCRIPT_OVERSCAN = 10

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
  if (itemCount <= windowSize) return { start: 0, end: itemCount }
  if (followTail) return visibleWindow(itemCount, virtualWindowForTail(itemCount, windowSize), windowSize)
  const first = Math.max(0, Math.floor(Math.max(0, scrollTop) / Math.max(1, estimatePx)) - overscan)
  const visible = Math.max(1, Math.ceil(Math.max(1, viewportHeight) / Math.max(1, estimatePx)) + overscan * 2)
  return visibleWindow(itemCount, first, Math.max(windowSize, visible))
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
