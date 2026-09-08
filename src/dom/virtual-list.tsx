/** @jsxImportSource react */
// DOM counterpart of gpuix's <virtual-list>. It owns a scroller, measures children, keeps the tail pinned when
// followTail is set, anchors the viewport across prepends, and reports visibleRange in logical indexes
// (windowStart + child offset) exactly like packages/native's VirtualListEntry.

import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { EventPayload, StyleDesc } from '@gpuix/react'
import { toCss } from './style.ts'
import { registerScrollHandle } from './host.tsx'
import {
  prependMeasuredHeights,
  recordMeasuredHeight,
  scheduleAnimationFrame,
  spacerHeight,
} from '../ui/virtual-window.ts'

interface Props {
  elementId: number
  setNode(node: HTMLElement | null): void
  children?: ReactNode
  style?: StyleDesc
  alignment?: 'top' | 'bottom'
  followTail?: boolean
  estimatedItemHeight?: number
  testId?: string
  itemCount?: number
  windowStart?: number
  onScroll?(event: EventPayload): void
  onVisibleRange?(event: EventPayload): void
}

function offsetInScroller(element: HTMLElement, scroller: HTMLElement): number {
  return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
}

function visibleChildRange(scroller: HTMLElement, kids: HTMLCollection): { first: number; last: number } | undefined {
  const count = kids.length
  if (count === 0) return undefined
  const sample = kids[0] as HTMLElement
  const view = scroller.getBoundingClientRect()
  const sampleRect = sample.getBoundingClientRect()
  if (sampleRect.height === 0 && sample.offsetHeight === 0 && sample.offsetTop === 0 && sampleRect.top === 0) return undefined
  const top = view.height > 0 ? view.top : 0
  const bottom = view.height > 0 ? view.bottom : Number.POSITIVE_INFINITY
  const childTop = (child: HTMLElement) => view.height > 0 ? child.getBoundingClientRect().top : offsetInScroller(child, scroller)
  const childBottom = (child: HTMLElement) => view.height > 0 ? child.getBoundingClientRect().bottom : offsetInScroller(child, scroller) + (child.getBoundingClientRect().height || child.offsetHeight)
  let lo = 0
  let hi = count - 1
  let first = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const child = kids[mid] as HTMLElement
    if (childBottom(child) <= top) lo = mid + 1
    else {
      first = mid
      hi = mid - 1
    }
  }
  let last = first
  for (let index = first; index < count; index += 1) {
    const child = kids[index] as HTMLElement
    if (childTop(child) >= bottom) break
    last = index
  }
  return { first, last }
}

export function DomVirtualList({ elementId, setNode, children, style, alignment = 'top', followTail = false, estimatedItemHeight = 72, testId, itemCount, windowStart = 0, onScroll, onVisibleRange }: Props) {
  const scroller = useRef<HTMLDivElement | null>(null)
  const content = useRef<HTMLDivElement | null>(null)
  const rendered = React.Children.count(children)
  const total = itemCount !== undefined && itemCount > rendered ? itemCount : rendered
  const before = Math.max(0, Math.min(windowStart, total - rendered))
  const after = Math.max(0, total - rendered - before)
  const childArray = React.Children.toArray(children)
  const heights = useRef<number[]>([])
  const appliedWindow = useRef({ total, positions: new Map<string, number>() })
  if (total > appliedWindow.current.total) {
    let shift: number | undefined
    let consistent = true
    for (let index = 0; index < childArray.length; index += 1) {
      const key = String((childArray[index] as { key?: React.Key | null }).key ?? '')
      const previousIndex = key ? appliedWindow.current.positions.get(key) : undefined
      if (previousIndex === undefined) continue
      const delta = before + index - previousIndex
      if (shift === undefined) shift = delta
      else if (shift !== delta) consistent = false
    }
    if (consistent && shift !== undefined && shift > 0) heights.current = prependMeasuredHeights(heights.current, shift)
  }
  const positions = new Map<string, number>()
  for (let index = 0; index < childArray.length; index += 1) {
    const key = String((childArray[index] as { key?: React.Key | null }).key ?? '')
    if (key) positions.set(key, before + index)
  }
  appliedWindow.current = { total, positions }
  const beforePx = spacerHeight(heights.current, 0, before, estimatedItemHeight)
  const afterPx = spacerHeight(heights.current, before + rendered, total, estimatedItemHeight)
  const [, setMeasureTick] = useState(0)
  const lastRange = useRef<[number, number, boolean] | undefined>(undefined)
  const lastWindowStart = useRef(windowStart)
  const lastBeforePx = useRef(beforePx)
  const lastScrollTop = useRef(0)
  const pendingAnchor = useRef<{ key: string; y: number } | undefined>(undefined)
  const firstKeyRef = useRef<string | undefined>(undefined)
  const followRef = useRef(followTail)
  followRef.current = followTail
  const cancelReport = useRef<(() => void) | undefined>(undefined)
  const onVisibleRangeRef = useRef(onVisibleRange)
  onVisibleRangeRef.current = onVisibleRange

  const measureMounted = () => {
    const list = content.current
    if (!list) return false
    const kids = list.children
    let changed = false
    for (let index = 0; index < kids.length; index += 1) {
      const height = (kids[index] as HTMLElement).getBoundingClientRect().height || (kids[index] as HTMLElement).offsetHeight
      const previous = heights.current[before + index] ?? 0
      recordMeasuredHeight(heights.current, before + index, height)
      if (height > 0 && height !== previous) changed = true
    }
    return changed
  }

  const report = () => {
    const node = scroller.current
    const list = content.current
    const notify = onVisibleRangeRef.current
    if (!node || !list || !notify) return
    const kids = list.children
    const visible = visibleChildRange(node, kids)
    let first: number
    let last: number
    if (!visible) {
      first = node.scrollTop < beforePx ? Math.floor(node.scrollTop / estimatedItemHeight) : before + kids.length
      last = first
    } else {
      first = visible.first + before
      last = visible.last + before
    }
    const atEnd = node.scrollTop + node.clientHeight >= node.scrollHeight - 1
    const range: [number, number, boolean] = [first, last + 1, atEnd]
    if (lastRange.current && lastRange.current[0] === range[0] && lastRange.current[1] === range[1] && lastRange.current[2] === range[2]) return
    lastRange.current = range
    notify({
      elementId,
      eventType: 'visibleRange',
      startIndex: range[0],
      endIndex: range[1],
      viewportHeight: node.clientHeight,
      atEnd,
    } as EventPayload)
  }

  const scheduleReport = () => {
    if (cancelReport.current) return
    cancelReport.current = scheduleAnimationFrame(() => {
      cancelReport.current = undefined
      if (measureMounted()) setMeasureTick((tick) => tick + 1)
      report()
    })
  }

  useEffect(() => registerScrollHandle(elementId, {
    scrollTo(x, y) { const node = scroller.current; if (node) { node.scrollLeft = x; node.scrollTop = y } },
    scrollToItem(index, offset = 0) {
      const node = scroller.current
      const child = content.current?.children[index - before] as HTMLElement | undefined
      if (!node) return
      const measured = spacerHeight(heights.current, 0, index, estimatedItemHeight)
      node.scrollTop = child ? offsetInScroller(child, node) + offset : measured + offset
    },
    offset() { const node = scroller.current; return node ? [node.scrollLeft, node.scrollTop] : [0, 0] },
  }), [before, elementId, estimatedItemHeight])

  const firstKey = childArray.length > 0 ? String((childArray[0] as { key?: React.Key | null }).key ?? '') : undefined
  if (firstKeyRef.current !== undefined && firstKey !== undefined && firstKeyRef.current !== firstKey && scroller.current && content.current && !followRef.current) {
    const previous = Array.from(content.current.children).find((child) => (child as HTMLElement).dataset.gxKey === firstKeyRef.current) as HTMLElement | undefined
    if (previous) pendingAnchor.current = { key: firstKeyRef.current, y: previous.getBoundingClientRect().top - scroller.current.getBoundingClientRect().top }
  }
  firstKeyRef.current = firstKey

  useLayoutEffect(() => {
    cancelReport.current?.()
    cancelReport.current = undefined
    const node = scroller.current
    if (!node) return
    const measuredChanged = measureMounted()
    if (pendingAnchor.current) {
      const anchor = pendingAnchor.current
      const target = Array.from(content.current?.children ?? []).find((child) => (child as HTMLElement).dataset.gxKey === anchor.key) as HTMLElement | undefined
      if (target) {
        const now = target.getBoundingClientRect().top - node.getBoundingClientRect().top
        node.scrollTop += now - anchor.y
      } else if (lastWindowStart.current !== windowStart && !followRef.current) {
        node.scrollTop += beforePx - lastBeforePx.current
      }
      pendingAnchor.current = undefined
    } else if (lastWindowStart.current !== windowStart && !followRef.current) {
      node.scrollTop += beforePx - lastBeforePx.current
    }
    lastWindowStart.current = windowStart
    lastBeforePx.current = beforePx
    if (followRef.current) node.scrollTop = node.scrollHeight
    lastScrollTop.current = node.scrollTop
    report()
    if (measuredChanged) setMeasureTick((tick) => tick + 1)
  })

  useEffect(() => {
    const node = scroller.current
    const list = content.current
    if (!node || !list || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (followRef.current) node.scrollTop = node.scrollHeight
      scheduleReport()
    })
    observer.observe(list)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => () => cancelReport.current?.(), [])

  const handleScroll = () => {
    const node = scroller.current
    if (!node) return
    const delta = node.scrollTop - lastScrollTop.current
    lastScrollTop.current = node.scrollTop
    if (delta !== 0) onScroll?.({ elementId, eventType: 'scroll', deltaY: -delta, precise: true })
    scheduleReport()
  }
  const handleWheel = () => {
    lastRange.current = undefined
    scheduleReport()
  }

  const css = toCss(style)
  return (
    <div
      ref={(el) => { scroller.current = el; setNode(el) }}
      className="gx-virtual-list"
      data-testid={testId}
      data-alignment={alignment}
      data-window-start={before}
      data-window-end={before + rendered}
      style={{ ...css, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', overflowAnchor: 'none' }}
      onScroll={handleScroll}
      onWheel={handleWheel}
    >
      {alignment === 'bottom' ? <div aria-hidden style={{ flexGrow: 1, flexShrink: 1, minHeight: 0 }} /> : null}
      {before > 0 ? <div aria-hidden data-testid="gx-window-before" style={{ height: beforePx, flexShrink: 0 }} /> : null}
      <div ref={content} className="gx-virtual-content" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: '100%', position: 'relative' }}>
        {childArray.map((child) => (
          <div key={(child as { key?: React.Key | null }).key ?? undefined} data-gx-key={String((child as { key?: React.Key | null }).key ?? '')} className="gx-virtual-row" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, width: '100%', position: 'relative' }}>{child}</div>
        ))}
      </div>
      {after > 0 ? <div aria-hidden data-testid="gx-window-after" style={{ height: afterPx, flexShrink: 0 }} /> : null}
    </div>
  )
}
