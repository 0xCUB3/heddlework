import React from 'react'

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

export function useNativeVirtualWindow(itemCount: number, identity: string, initialStart = 0, windowSize = 160): NativeVirtualWindow {
  const maxStart = Math.max(0, itemCount - windowSize)
  const defaultStart = Math.max(0, Math.min(maxStart, initialStart))
  const [window, setWindow] = React.useState(() => ({ identity, start: defaultStart }))
  const windowStart = window.identity === identity ? Math.max(0, Math.min(maxStart, window.start)) : defaultStart
  const windowEnd = Math.min(itemCount, windowStart + windowSize)
  const onVisibleRange = React.useCallback((event: NativeVisibleRangeEvent) => {
    const first = Math.max(0, Math.floor(event.startIndex ?? 0))
    const last = Math.max(first, Math.floor(event.endIndex ?? first))
    const margin = Math.max(8, Math.floor(windowSize / 4))
    if (first >= windowStart + margin && last < windowEnd - margin) return
    const nextStart = Math.max(0, Math.min(maxStart, first - margin))
    if (nextStart === windowStart && window.identity === identity) return
    setWindow({ identity, start: nextStart })
  }, [identity, maxStart, window.identity, windowEnd, windowSize, windowStart])
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
