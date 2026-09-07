import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { WorkbenchControllerSurface } from '../src/workbench/controller-surface.ts'
import { createInitialState } from '../src/workbench/state.ts'
import type { ThreadTitleSettings } from '../src/workbench/thread-titles.ts'
import { SettingsView } from '../src/ui/settings-view.tsx'
import { DEFAULT_INTERFACE_FONTS } from '../src/ui/theme.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('thread title settings', () => {
  it('toggles automatic titles through the controller', async () => {
    const calls: Array<Partial<ThreadTitleSettings>> = []
    const controller = {
      setThreadTitleSettings(settings: Partial<ThreadTitleSettings>) {
        calls.push(settings)
      },
    } as WorkbenchControllerSurface
    const root = createTestRoot({ width: 780, height: 1100 })
    root.render(
      <SettingsView
        state={createInitialState('/tmp/thread-titles')}
        controller={controller}
        theme={{ mode: 'dark', resolved: 'dark', fonts: DEFAULT_INTERFACE_FONTS }}
        onThemeModeChange={() => undefined}
        onClose={() => undefined}
      />,
    )
    const automation = await connectTest(root.renderer)
    try {
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await automation.getByTestId('settings-threads').count()).toBe(1)
      expect(await automation.getByTestId('settings-title-model').count()).toBe(1)
      expect(await automation.getByTestId('settings-title-instructions').count()).toBe(1)
      await automation.getByTestId('settings-auto-titles-off').click()
      expect(calls).toEqual([{ autoTitles: false }])
    } finally {
      await automation.close()
      root.unmount()
    }
  })

  it('keeps Settings on the native scroll surface within the wheel-event budget', async () => {
    const root = createTestRoot({ width: 900, height: 640 })
    root.render(
      <SettingsView
        state={createInitialState('/tmp/settings-scroll-performance')}
        controller={{ reconnect() {}, setThreadTitleSettings() {} } as unknown as WorkbenchControllerSurface}
        theme={{ mode: 'dark', resolved: 'dark', fonts: DEFAULT_INTERFACE_FONTS }}
        onThemeModeChange={() => undefined}
        onClose={() => undefined}
      />,
    )
    const automation = await connectTest(root.renderer)
    try {
      root.renderer.flush()
      const viewport = await automation.getByTestId('settings-scroll').bounds()
      const scroll = root.renderer.findByTestId('settings-scroll-native')!
      expect(scroll.type).toBe('virtual-list')
      const before = await automation.getByTestId('settings-alpha').bounds()
      const point = { x: viewport.x + viewport.width / 2, y: viewport.y + 40 }
      const started = performance.now()
      for (let index = 0; index < 40; index++) {
        await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: -120 })
      }
      root.renderer.flush()
      const elapsed = performance.now() - started
      const after = await automation.getByTestId('settings-alpha').bounds()
      expect(after.y).toBeLessThan(before.y - 100)
      expect(root.renderer.getScrollOffset(scroll.id)?.[1] ?? 0).toBeLessThan(-100)
      expect(elapsed).toBeLessThan(process.env.CI ? 800 : 400)
    } finally {
      await automation.close()
      root.unmount()
    }
  })
})
