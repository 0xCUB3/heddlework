import React from 'react'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { WorkbenchControllerSurface } from '../src/workbench/controller-surface.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { SettingsView } from '../src/ui/settings-view.tsx'
import { DEFAULT_INTERFACE_FONTS } from '../src/ui/theme.ts'

if (!hasNativeTestRenderer) throw new Error('GPUix native test renderer is unavailable')

const root = createTestRoot({ width: 900, height: 640 })
root.render(
  <SettingsView
    state={createInitialState('/tmp/settings-scroll-benchmark')}
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
  const point = { x: viewport.x + viewport.width / 2, y: viewport.y + 40 }
  const started = performance.now()
  for (let index = 0; index < 200; index++) {
    await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: index % 2 ? 120 : -120 })
  }
  root.renderer.flush()
  console.log(`settings 200 synthetic wheel events: ${(performance.now() - started).toFixed(1)} ms`)
} finally {
  await automation.close()
  root.unmount()
}
