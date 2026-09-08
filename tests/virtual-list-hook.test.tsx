/** @jsxImportSource react */
import { describe, expect, it } from 'bun:test'
import { Window } from 'happy-dom'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { useNativeVirtualWindow, type NativeVirtualWindow } from '../src/ui/virtual-list.tsx'

function installDom(): () => void {
  const win = new Window({ url: 'http://localhost/' })
  const g = globalThis as Record<string, unknown>
  const saved = new Map<string, unknown>()
  const w = win as unknown as Record<string, unknown>
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'Element', 'Event']) {
    saved.set(key, g[key])
    g[key] = key === 'window' ? win : w[key]
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  return () => { for (const [key, value] of saved) g[key] = value }
}

function harness() {
  let latest: NativeVirtualWindow | undefined
  let renders = 0
  function Hook(props: { count: number; identity: string; initial?: number; size?: number; prepended?: number }) {
    renders += 1
    latest = useNativeVirtualWindow(props.count, props.identity, props.initial ?? 0, props.size ?? 40, props.prepended === undefined ? {} : { prepended: props.prepended })
    return null
  }
  return { Hook, latest: () => latest!, renders: () => renders }
}

describe('useNativeVirtualWindow races', () => {
  it('consumes a prepend exactly once even when the prepended prop remains nonzero during the hook state rerender', async () => {
    const restore = installDom()
    try {
      const host = document.createElement('div')
      const root = createRoot(host)
      const h = harness()
      await act(async () => { root.render(<h.Hook count={100} identity="session" initial={20} prepended={0} />) })
      expect(h.latest().windowStart).toBe(20)
      await act(async () => { root.render(<h.Hook count={102} identity="session" initial={20} prepended={2} />) })
      expect(h.latest().windowStart).toBe(22)
      await act(async () => { root.unmount() })
    } finally { restore() }
  })

  it('ignores a visible-range callback retained by the old session', async () => {
    const restore = installDom()
    try {
      const host = document.createElement('div')
      const root = createRoot(host)
      const h = harness()
      await act(async () => { root.render(<h.Hook count={400} identity="old" initial={100} />) })
      const stale = h.latest().onVisibleRange
      await act(async () => { root.render(<h.Hook count={400} identity="new" initial={0} />) })
      expect(h.latest().windowStart).toBe(0)
      const before = h.renders()
      await act(async () => { stale({ startIndex: 220, endIndex: 230 }) })
      expect(h.latest().windowStart).toBe(0)
      expect(h.renders()).toBe(before)
      await act(async () => { root.unmount() })
    } finally { restore() }
  })

  it('uses the latest rendered window size when an earlier same-session callback fires after resize', async () => {
    const restore = installDom()
    try {
      const host = document.createElement('div')
      const root = createRoot(host)
      const h = harness()
      await act(async () => { root.render(<h.Hook count={400} identity="same" initial={100} size={12} />) })
      const beforeResize = h.latest().onVisibleRange
      await act(async () => { root.render(<h.Hook count={400} identity="same" initial={100} size={80} />) })
      await act(async () => { beforeResize({ startIndex: 175, endIndex: 185 }) })
      expect(h.latest().windowEnd - h.latest().windowStart).toBe(80)
      expect(h.latest().windowStart).toBe(167)
      await act(async () => { root.unmount() })
    } finally { restore() }
  })
})
