/** @jsxImportSource react */
// A DOM list that fits its viewport never fires scroll, so the wheel itself must re-report the visible range or
// scroll-driven history paging can never start on web.
import { describe, expect, it } from 'bun:test'
import { Window } from 'happy-dom'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { DomVirtualList } from '../src/dom/virtual-list.tsx'

function installDom(): () => void {
  const win = new Window({ innerWidth: 800, innerHeight: 600, url: 'http://localhost/' })
  const g = globalThis as Record<string, unknown>
  const saved = new Map<string, unknown>()
  const w = win as unknown as Record<string, unknown>
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'MouseEvent', 'WheelEvent', 'ResizeObserver', 'getComputedStyle']) {
    saved.set(key, g[key])
    g[key] = key === 'window' ? win : w[key]
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  return () => { for (const [key, value] of saved) g[key] = value }
}

describe('DomVirtualList wheel reporting', () => {
  it('re-emits the visible range on wheel even when the scroller cannot move', async () => {
    const restore = installDom()
    try {
      const ranges: Array<[number, number]> = []
      const scrolls: number[] = []
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          <DomVirtualList
            elementId={1}
            setNode={() => {}}
            testId="list"
            onVisibleRange={(event) => ranges.push([event.startIndex as number, event.endIndex as number])}
            onScroll={(event) => scrolls.push(event.deltaY as number)}
          >
            <div key="a">a</div>
            <div key="b">b</div>
          </DomVirtualList>,
        )
      })
      const mountReports = ranges.length
      expect(mountReports).toBeGreaterThan(0)
      const list = host.querySelector('[data-testid="list"]') as HTMLElement
      await act(async () => {
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
      })
      // Nothing scrolled (happy-dom has no layout), so a scroll-only report would have stayed silent.
      expect(scrolls).toEqual([])
      expect(ranges.length).toBe(mountReports + 1)
      expect(ranges.at(-1)).toEqual(ranges[0])
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })
})
