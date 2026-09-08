import React from 'react'
import {
  DEFAULT_VIRTUAL_WINDOW_SIZE,
  adaptiveOverscanRows,
  adaptiveWindowSize,
  averageMeasuredHeight,
  clampVirtualWindowStart,
  countPrependedIds,
} from './virtual-window.ts'

export {
  DEFAULT_VIRTUAL_WINDOW_SIZE,
  SIDEBAR_VIRTUAL_WINDOW_SIZE,
  TRANSCRIPT_OVERSCAN_ROWS,
  TRANSCRIPT_VIRTUAL_WINDOW_SIZE,
  TRANSCRIPT_VIEWPORT_FALLBACK_PX,
  WEB_TRANSCRIPT_ROW_ESTIMATE_PX,
  WEB_TRANSCRIPT_WINDOW_SIZE,
  adaptiveOverscanRows,
  adaptiveWindowSize,
  clampVirtualWindowStart,
  countPrependedIds,
  virtualWindowForTail,
  visibleWindow,
  webTranscriptWindow,
} from './virtual-window.ts'

export interface NativeElementHandle {
  id: number
}

export interface NativeScrollEvent {
  elementId: number
  deltaY?: number
  precise?: boolean
}

export interface NativeVisibleRangeEvent {
  startIndex?: number
  endIndex?: number
  viewportHeight?: number
  atEnd?: boolean
}

export interface NativeVirtualWindow {
  windowStart: number
  windowEnd: number
  onVisibleRange(event: NativeVisibleRangeEvent): void
}

export function usePrependCount(ids: readonly string[], identity: string): number {
  const previous = React.useRef({ identity, ids })
  if (previous.current.identity !== identity) {
    previous.current = { identity, ids }
    return 0
  }
  const prepended = countPrependedIds(previous.current.ids, ids)
  previous.current = { identity, ids }
  return prepended
}

export function useNativeVirtualWindow(
  itemCount: number,
  identity: string,
  initialStart = 0,
  windowSize = DEFAULT_VIRTUAL_WINDOW_SIZE,
  options: {
    pinToEnd?: boolean
    prepended?: number
    viewportHeight?: number
    estimatedItemHeight?: number
    overscan?: number
    measuredHeights?: readonly number[]
  } = {},
): NativeVirtualWindow {
  const estimatedItemHeight = options.estimatedItemHeight ?? 88
  const measuredAverage = options.measuredHeights
    ? averageMeasuredHeight(options.measuredHeights, estimatedItemHeight)
    : estimatedItemHeight
  const sized = options.viewportHeight == null
    ? windowSize
    : adaptiveWindowSize(
      options.viewportHeight,
      measuredAverage,
      options.overscan ?? adaptiveOverscanRows(options.viewportHeight, measuredAverage),
      windowSize,
    )
  const resolvedWindowSize = itemCount <= Math.max(sized * 2, 48) ? Math.max(sized, itemCount) : sized
  const maxStart = Math.max(0, itemCount - resolvedWindowSize)
  const pinToEnd = Boolean(options.pinToEnd)
  const prepended = options.prepended ?? 0
  const defaultStart = pinToEnd ? maxStart : clampVirtualWindowStart(itemCount, initialStart, resolvedWindowSize)
  const [window, setWindow] = React.useState(() => ({ identity, start: defaultStart, itemCount }))
  const sameIdentity = window.identity === identity
  let start = sameIdentity ? window.start : defaultStart
  if (sameIdentity && itemCount > window.itemCount && prepended > 0) start += prepended
  if (pinToEnd) start = maxStart
  const windowStart = clampVirtualWindowStart(itemCount, start, resolvedWindowSize)
  const windowEnd = Math.min(itemCount, windowStart + resolvedWindowSize)
  if (!sameIdentity || window.itemCount !== itemCount || window.start !== windowStart) {
    setWindow({ identity, start: windowStart, itemCount })
  }
  const overscan = options.overscan ?? (options.viewportHeight == null
    ? 8
    : adaptiveOverscanRows(options.viewportHeight, measuredAverage))
  const activeIdentity = React.useRef(identity)
  activeIdentity.current = identity
  const rangeConfig = React.useRef({ identity, itemCount, overscan, resolvedWindowSize, windowEnd, windowStart })
  rangeConfig.current = { identity, itemCount, overscan, resolvedWindowSize, windowEnd, windowStart }
  const onVisibleRange = React.useCallback((event: NativeVisibleRangeEvent) => {
    if (activeIdentity.current !== identity) return
    const current = rangeConfig.current
    if (current.identity !== identity) return
    const first = Math.max(0, Math.floor(event.startIndex ?? 0))
    const last = Math.max(first, Math.floor(event.endIndex ?? first))
    const margin = Math.max(2, Math.min(current.overscan, Math.floor(current.resolvedWindowSize / 4) || 2))
    if (first >= current.windowStart + margin && last < current.windowEnd - margin) return
    const nextStart = clampVirtualWindowStart(current.itemCount, first - margin, current.resolvedWindowSize)
    if (nextStart === current.windowStart) return
    setWindow({ identity, start: nextStart, itemCount: current.itemCount })
  }, [identity])
  return { windowStart, windowEnd, onVisibleRange }
}

export function NativeVirtualList({
  children,
  style,
  alignment = 'top',
  followTail = false,
  overdraw,
  estimatedItemHeight,
  testId,
  onScroll,
  onVisibleRange,
  elementRef,
  itemCount,
  windowStart,
}: {
  children: React.ReactNode
  style: Record<string, unknown>
  alignment?: 'top' | 'bottom'
  followTail?: boolean
  overdraw?: number
  estimatedItemHeight?: number
  testId?: string
  onScroll?(event: NativeScrollEvent): void
  onVisibleRange?(event: NativeVisibleRangeEvent): void
  elementRef?: React.Ref<NativeElementHandle>
  itemCount?: number
  windowStart?: number
}) {
  const renderedItemCount = React.Children.count(children)
  const externallyWindowed = itemCount !== undefined && itemCount > renderedItemCount
  return React.createElement('virtual-list', {
    alignment,
    followTail,
    overdraw,
    estimatedItemHeight,
    style,
    ...(testId ? { testId } : {}),
    ...(onScroll ? { onScroll } : {}),
    ...(onVisibleRange ? { onVisibleRange } : {}),
    ...(elementRef ? { ref: elementRef } : {}),
    ...(externallyWindowed ? { itemCount, windowStart: windowStart ?? 0 } : {}),
  } as never, children)
}
