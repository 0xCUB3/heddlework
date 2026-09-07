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
})
