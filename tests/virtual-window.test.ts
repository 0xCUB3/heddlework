import { describe, expect, it } from 'bun:test'
import {
  clampVirtualWindowStart,
  countPrependedIds,
  reuseRowsById,
  virtualWindowForTail,
  visibleWindow,
  WEB_TRANSCRIPT_WINDOW_SIZE,
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

  it('windows a long web transcript at the tail while following, then around scrollTop', () => {
    const following = webTranscriptWindow(1_000, 0, 640, true)
    expect(following.end).toBe(1_000)
    expect(following.start).toBe(1_000 - WEB_TRANSCRIPT_WINDOW_SIZE)
    expect(following.end - following.start).toBe(WEB_TRANSCRIPT_WINDOW_SIZE)

    const scrolled = webTranscriptWindow(1_000, 72 * 200, 640, false)
    expect(scrolled.start).toBeGreaterThan(150)
    expect(scrolled.start).toBeLessThan(210)
    expect(scrolled.end - scrolled.start).toBeGreaterThanOrEqual(WEB_TRANSCRIPT_WINDOW_SIZE)
    expect(webTranscriptWindow(20, 0, 640, true)).toEqual({ start: 0, end: 20 })
  })
})
