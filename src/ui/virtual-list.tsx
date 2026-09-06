import React from 'react'
import {
  DEFAULT_VIRTUAL_WINDOW_SIZE,
  clampVirtualWindowStart,
  countPrependedIds,
} from './virtual-window.ts'

export {
  DEFAULT_VIRTUAL_WINDOW_SIZE,
  SIDEBAR_VIRTUAL_WINDOW_SIZE,
  TRANSCRIPT_VIRTUAL_WINDOW_SIZE,
  WEB_TRANSCRIPT_ROW_ESTIMATE_PX,
  WEB_TRANSCRIPT_WINDOW_SIZE,
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
  options: { pinToEnd?: boolean; prepended?: number } = {},
): NativeVirtualWindow {
  const maxStart = Math.max(0, itemCount - windowSize)
  const pinToEnd = Boolean(options.pinToEnd)
  const prepended = options.prepended ?? 0
  const defaultStart = pinToEnd ? maxStart : clampVirtualWindowStart(itemCount, initialStart, windowSize)
  const [window, setWindow] = React.useState(() => ({ identity, start: defaultStart }))
  let start = window.identity === identity ? window.start : defaultStart
  if (window.identity === identity && prepended > 0 && start > 0) start += prepended
  if (pinToEnd) start = maxStart
  const windowStart = clampVirtualWindowStart(itemCount, start, windowSize)
  const windowEnd = Math.min(itemCount, windowStart + windowSize)
  if (window.identity !== identity || ((prepended > 0 || pinToEnd) && window.start !== windowStart)) {
    setWindow({ identity, start: windowStart })
  }
  const onVisibleRange = React.useCallback((event: NativeVisibleRangeEvent) => {
    const first = Math.max(0, Math.floor(event.startIndex ?? 0))
    const last = Math.max(first, Math.floor(event.endIndex ?? first))
    const margin = Math.max(8, Math.floor(windowSize / 4))
    if (first >= windowStart + margin && last < windowEnd - margin) return
    const nextStart = clampVirtualWindowStart(itemCount, first - margin, windowSize)
    if (nextStart === windowStart && window.identity === identity) return
    setWindow({ identity, start: nextStart })
  }, [identity, itemCount, window.identity, windowEnd, windowSize, windowStart])
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
