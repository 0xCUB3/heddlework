import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { HostSwitcherSnapshot, HostSwitcherSurface } from '../src/client/host-switcher.ts'
import type { SavedHost } from '../src/client/saved-hosts.ts'
import type { HostIdentity } from '../src/protocol/host-identity.ts'
import { HostBadge } from '../src/ui/host-badge.tsx'
import { HostPicker } from '../src/ui/host-picker.tsx'
import { colors } from '../src/ui/theme.ts'

const native = hasNativeTestRenderer ? describe : describe.skip

const studio: HostIdentity = { id: 'studio-id', name: 'Studio', os: 'darwin', arch: 'arm64', machine: 'mac-studio', version: '1', protocol: 1 }

const savedStudio: SavedHost = {
  id: 'studio-id',
  name: 'Studio',
  url: 'http://studio.local:4817',
  token: 'tok',
  hostUrls: ['http://studio.local:4817'],
  machine: 'mac-studio',
  os: 'darwin',
  lastSeenAt: Date.now(),
}

function fakeSwitcher(snapshot: HostSwitcherSnapshot, handlers: Partial<Pick<HostSwitcherSurface, 'connect' | 'useLocal' | 'forget' | 'rename'>> = {}): HostSwitcherSurface {
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snapshot,
    connect: handlers.connect ?? (async () => undefined),
    useLocal: handlers.useLocal ?? (async () => undefined),
    forget: handlers.forget ?? (() => undefined),
    rename: handlers.rename ?? (() => undefined),
  }
}

native('HostBadge', () => {
  it('renders the local name without a tinted background', async () => {
    const root = createTestRoot()
    const snapshot: HostSwitcherSnapshot = {
      current: { origin: 'local', identity: undefined, url: 'http://127.0.0.1:4817', status: 'open' },
      saved: [],
      busy: false,
      canUseLocal: true,
    }
    root.render(<HostBadge snapshot={snapshot} onClick={() => undefined} />)
    await Bun.sleep(0)
    root.renderer.flush()
    const app = await connectTest(root.renderer)
    try {
      expect(await app.getByTestId('host-badge-name').textContent()).toBe(process.platform === 'darwin' ? 'This Mac' : 'Local')
      expect(root.renderer.findByTestId('host-badge')?.style?.backgroundColor).toBe(colors.transparent)
    } finally {
      await app.close()
      root.unmount()
    }
  })

  it('renders the remote name with a tinted background', async () => {
    const root = createTestRoot()
    const snapshot: HostSwitcherSnapshot = {
      current: { origin: 'remote', identity: studio, url: 'http://studio.local:4817', status: 'open' },
      saved: [],
      busy: false,
      canUseLocal: true,
    }
    root.render(<HostBadge snapshot={snapshot} onClick={() => undefined} />)
    await Bun.sleep(0)
    root.renderer.flush()
    const app = await connectTest(root.renderer)
    try {
      expect(await app.getByTestId('host-badge-name').textContent()).toBe('Studio')
      const badge = root.renderer.findByTestId('host-badge')
      expect(badge?.style?.backgroundColor).toBe(colors.raised)
      expect(badge?.style?.borderColor).toBe(colors.borderStrong)
      expect(badge?.style?.borderWidth).toBe(1)
    } finally {
      await app.close()
      root.unmount()
    }
  })
})

native('HostPicker', () => {
  it('connects from a saved host row', async () => {
    const calls: Array<{ link: string } | { savedId: string }> = []
    const snapshot: HostSwitcherSnapshot = {
      current: { origin: 'local', identity: undefined, url: 'http://127.0.0.1:4817', status: 'open' },
      saved: [savedStudio],
      busy: false,
      canUseLocal: true,
    }
    const switcher = fakeSwitcher(snapshot, {
      connect: async (target) => { calls.push(target) },
    })
    const root = createTestRoot({ width: 640, height: 480 })
    root.render(<HostPicker switcher={switcher} open onClose={() => undefined} />)
    await Bun.sleep(0)
    root.renderer.flush()
    const app = await connectTest(root.renderer)
    try {
      await app.getByTestId('host-picker-saved-studio-id').click()
      expect(calls).toEqual([{ savedId: 'studio-id' }])
    } finally {
      await app.close()
      root.unmount()
    }
  })
})
