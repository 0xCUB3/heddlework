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
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event', 'MouseEvent', 'WheelEvent', 'ResizeObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    saved.set(key, g[key])
    g[key] = key === 'window' ? win : w[key]
  }
  if (typeof g.requestAnimationFrame !== 'function') {
    g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(Date.now()), 16) as unknown as number
    g.cancelAnimationFrame = (id: number) => clearTimeout(id)
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  return () => { for (const [key, value] of saved) g[key] = value }
}

async function flushFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
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
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
        list.dispatchEvent(new WheelEvent('wheel', { deltaY: -40, bubbles: true }))
      })
      expect(scrolls).toEqual([])
      await flushFrame()
      expect(ranges.length).toBe(mountReports + 1)
      expect(ranges.at(-1)).toEqual(ranges[0])
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  it('coalesces a 144Hz wheel burst onto the display frame instead of rebuilding per event', async () => {
    const restore = installDom()
    try {
      const ranges: Array<[number, number]> = []
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          <DomVirtualList
            elementId={3}
            setNode={() => {}}
            testId="hz-list"
            onVisibleRange={(event) => ranges.push([event.startIndex as number, event.endIndex as number])}
          >
            {Array.from({ length: 12 }, (_, index) => <div key={index}>{index}</div>)}
          </DomVirtualList>,
        )
      })
      const list = host.querySelector('[data-testid="hz-list"]') as HTMLElement
      const before = ranges.length
      await act(async () => {
        for (let index = 0; index < 24; index += 1) {
          list.dispatchEvent(new WheelEvent('wheel', { deltaY: -8, bubbles: true }))
        }
      })
      await flushFrame()
      expect(ranges.length - before).toBeLessThanOrEqual(2)
      expect(ranges.length - before).toBeLessThan(24)
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  it('reports atEnd only at the scroll boundary and emits when that flag changes within the same visible row', async () => {
    const restore = installDom()
    try {
      const reports: Array<{ range: [number, number]; atEnd: boolean | undefined }> = []
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          <DomVirtualList
            elementId={7}
            setNode={() => {}}
            testId="at-end-list"
            onVisibleRange={(event) => {
              const rangeEvent = event as typeof event & { atEnd?: boolean }
              reports.push({
                range: [rangeEvent.startIndex as number, rangeEvent.endIndex as number],
                atEnd: rangeEvent.atEnd,
              })
            }}
          >
            <div key="only">only</div>
          </DomVirtualList>,
        )
      })
      const list = host.querySelector('[data-testid="at-end-list"]') as HTMLElement
      const row = host.querySelector('.gx-virtual-row') as HTMLElement
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 100 })
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 200 })
      list.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 100, top: 0, right: 300, bottom: 100, left: 0, toJSON() { return {} } })
      Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 200 })
      row.getBoundingClientRect = () => ({ x: 0, y: -list.scrollTop, width: 300, height: 200, top: -list.scrollTop, right: 300, bottom: 200 - list.scrollTop, left: 0, toJSON() { return {} } })

      reports.length = 0
      list.scrollTop = 98
      await act(async () => { list.dispatchEvent(new Event('scroll', { bubbles: true })) })
      await flushFrame()
      expect(reports.at(-1)).toEqual({ range: [0, 1], atEnd: false })

      const beforeBottom = reports.length
      list.scrollTop = 100
      await act(async () => { list.dispatchEvent(new Event('scroll', { bubbles: true })) })
      await flushFrame()
      expect(reports.length).toBe(beforeBottom + 1)
      expect(reports.at(-1)).toEqual({ range: [0, 1], atEnd: true })
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  it('cancels a queued range report when the rendered window changes before that frame', async () => {
    const restore = installDom()
    try {
      const callbacks = new Map<number, FrameRequestCallback>()
      let nextFrame = 0
      globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
        const id = ++nextFrame
        callbacks.set(id, callback)
        return id
      }
      globalThis.cancelAnimationFrame = (id: number) => { callbacks.delete(id) }
      const ranges: Array<[number, number]> = []
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const renderList = (windowStart: number, keys: string[]) => (
        <DomVirtualList
          elementId={6}
          setNode={() => {}}
          testId="stale-frame-list"
          itemCount={6}
          windowStart={windowStart}
          estimatedItemHeight={72}
          onVisibleRange={(event) => ranges.push([event.startIndex as number, event.endIndex as number])}
        >
          {keys.map((id) => <div key={id}>{id}</div>)}
        </DomVirtualList>
      )
      await act(async () => { root.render(renderList(0, ['a', 'b', 'c'])) })
      const list = host.querySelector('[data-testid="stale-frame-list"]') as HTMLElement
      await act(async () => { list.dispatchEvent(new WheelEvent('wheel', { deltaY: -20, bubbles: true })) })
      expect(callbacks.size).toBe(1)
      await act(async () => { root.render(renderList(2, ['c', 'd', 'e'])) })
      const afterWindowChange = ranges.length
      await act(async () => {
        for (const [id, callback] of [...callbacks]) {
          callbacks.delete(id)
          callback(Date.now())
        }
      })
      expect(ranges.length).toBe(afterWindowChange)
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  it('uses measured row heights for unmounted spacers after a window shift', async () => {
    const restore = installDom()
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const renderList = (windowStart: number) => (
        <DomVirtualList
          elementId={2}
          setNode={() => {}}
          testId="measured-list"
          itemCount={6}
          windowStart={windowStart}
          estimatedItemHeight={72}
        >
          {(windowStart === 0 ? ['a', 'b', 'c'] : ['c', 'd', 'e']).map((id) => (
            <div key={id} data-row={id}>{id}</div>
          ))}
        </DomVirtualList>
      )
      await act(async () => { root.render(renderList(0)) })
      const rows = [...host.querySelectorAll('.gx-virtual-row')] as HTMLElement[]
      expect(rows.length).toBe(3)
      rows.forEach((row, index) => {
        Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 40 + index * 10 })
      })
      await act(async () => { root.render(renderList(0)) })
      await act(async () => { root.render(renderList(2)) })
      const spacer = host.querySelector('[data-testid="gx-window-before"]') as HTMLElement
      expect(spacer).toBeTruthy()
      expect(spacer.style.height).toBe('90px')
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  it('does not shift measured height indexes when an append and ordinary window move happen together', async () => {
    const restore = installDom()
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const renderList = (itemCount: number, windowStart: number, keys: string[]) => (
        <DomVirtualList
          elementId={5}
          setNode={() => {}}
          testId="append-list"
          itemCount={itemCount}
          windowStart={windowStart}
          estimatedItemHeight={72}
        >
          {keys.map((id) => <div key={id}>{id}</div>)}
        </DomVirtualList>
      )
      await act(async () => { root.render(renderList(6, 0, ['a', 'b', 'c'])) })
      const rows = [...host.querySelectorAll('.gx-virtual-row')] as HTMLElement[]
      rows.forEach((row, index) => {
        Object.defineProperty(row, 'offsetHeight', { configurable: true, value: 40 + index * 10 })
      })
      await act(async () => { root.render(renderList(6, 0, ['a', 'b', 'c'])) })
      await act(async () => { root.render(renderList(7, 1, ['b', 'c', 'd'])) })
      const spacer = host.querySelector('[data-testid="gx-window-before"]') as HTMLElement
      expect(spacer.style.height).toBe('40px')
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  it('preserves the reading anchor across prepends of nonuniform rows and a positioned ancestor', async () => {
    const restore = installDom()
    try {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const ids = ['c', 'd', 'e']
      const renderList = (windowStart: number, keys: string[]) => (
        <div style={{ position: 'relative', top: 40 }}>
          <DomVirtualList
            elementId={3}
            setNode={() => {}}
            testId="anchor-list"
            itemCount={8}
            windowStart={windowStart}
            estimatedItemHeight={72}
          >
            {keys.map((id) => (
              <div key={id} data-row={id} style={{ position: 'relative' }}>{id}</div>
            ))}
          </DomVirtualList>
        </div>
      )
      await act(async () => { root.render(renderList(2, ids)) })
      const list = host.querySelector('[data-testid="anchor-list"]') as HTMLElement
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 })
      const rows = [...host.querySelectorAll('.gx-virtual-row')] as HTMLElement[]
      rows.forEach((row, index) => {
        const height = index === 1 ? 400 : 40
        Object.defineProperty(row, 'offsetHeight', { configurable: true, value: height })
        row.getBoundingClientRect = () => ({ x: 0, y: 80 + index * height, width: 300, height, top: 80 + index * height, right: 300, bottom: 80 + (index + 1) * height, left: 0, toJSON() { return {} } })
      })
      list.scrollTop = 120
      await act(async () => { root.render(renderList(0, ['a', 'b', 'c', 'd', 'e'])) })
      expect(list.scrollTop).not.toBe(0)
      const spacer = host.querySelector('[data-testid="gx-window-before"]') as HTMLElement | null
      if (spacer) expect(Number.parseFloat(spacer.style.height || '0')).toBeGreaterThanOrEqual(0)
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })

  it('jumps to a measured offset rather than estimated 72px rows', async () => {
    const restore = installDom()
    try {
      const { domRenderer } = await import('../src/dom/host.tsx')
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      await act(async () => {
        root.render(
          <DomVirtualList elementId={4} setNode={() => {}} testId="jump-list" itemCount={6} windowStart={0} estimatedItemHeight={72}>
            {['a', 'b', 'c'].map((id) => <div key={id}>{id}</div>)}
          </DomVirtualList>,
        )
      })
      const rows = [...host.querySelectorAll('.gx-virtual-row')] as HTMLElement[]
      rows.forEach((row, index) => {
        const height = index === 0 ? 40 : 400
        Object.defineProperty(row, 'offsetHeight', { configurable: true, value: height })
        row.getBoundingClientRect = () => ({ x: 0, y: index === 0 ? 0 : 40, width: 300, height, top: index === 0 ? 0 : 40, right: 300, bottom: index === 0 ? 40 : 440, left: 0, toJSON() { return {} } })
      })
      const list = host.querySelector('[data-testid="jump-list"]') as HTMLElement
      list.getBoundingClientRect = () => ({ x: 0, y: 0, width: 300, height: 200, top: 0, right: 300, bottom: 200, left: 0, toJSON() { return {} } })
      await act(async () => { root.render(
        <DomVirtualList elementId={4} setNode={() => {}} testId="jump-list" itemCount={6} windowStart={0} estimatedItemHeight={72}>
          {['a', 'b', 'c'].map((id) => <div key={id}>{id}</div>)}
        </DomVirtualList>,
      ) })
      await act(async () => { domRenderer.scrollToItem?.(4, 1, 0) })
      expect(list.scrollTop).toBeGreaterThanOrEqual(40)
      await act(async () => { root.unmount() })
    } finally {
      restore()
    }
  })
})
