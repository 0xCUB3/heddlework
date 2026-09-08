import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { WorkbenchControllerSurface } from '../src/workbench/controller-surface.ts'
import { createInitialState } from '../src/workbench/state.ts'
import type { ThreadTitleSettings } from '../src/workbench/thread-titles.ts'
import { SettingsView } from '../src/ui/settings-view.tsx'
import { DEFAULT_INTERFACE_FONTS } from '../src/ui/theme.ts'
import { ResponsiveLayoutProvider, resolveResponsiveLayout } from '../src/ui/responsive.tsx'
import { DEFAULT_TERMINAL_APPEARANCE } from '../src/terminal/appearance.ts'
import type { TerminalSessionService } from '../src/terminal/service.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { ThemeManager } from '../src/ui/theme-manager.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

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
      expect(root.renderer.getPaintedText()).not.toContain('Alpha')
      const point = { x: viewport.x + viewport.width / 2, y: viewport.y + 40 }
      const started = performance.now()
      for (let index = 0; index < 40; index++) {
        await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: -120 })
      }
      root.renderer.flush()
      const elapsed = performance.now() - started
      const after = await automation.getByTestId('settings-alpha').bounds()
      expect(root.renderer.getScrollOffset(scroll.id)?.[1] ?? 0).toBeLessThan(-100)
      expect(after.y + after.height).toBeLessThanOrEqual(viewport.y + viewport.height + 1)
      expect(elapsed).toBeLessThan(process.env.CI ? 800 : 400)
    } finally {
      await automation.close()
      root.unmount()
    }
  })

  it('keeps narrow Settings rows inside the responsive content gutter', async () => {
    const root = createTestRoot({ width: 390, height: 760 })
    root.render(
      <ResponsiveLayoutProvider layout={resolveResponsiveLayout(390)}>
        <SettingsView
          state={createInitialState('/tmp/settings-mobile-gutter')}
          controller={{ reconnect() {}, setThreadTitleSettings() {} } as unknown as WorkbenchControllerSurface}
          theme={{ mode: 'dark', resolved: 'dark', fonts: DEFAULT_INTERFACE_FONTS }}
          onThemeModeChange={() => undefined}
          onClose={() => undefined}
        />
      </ResponsiveLayoutProvider>,
    )
    const automation = await connectTest(root.renderer)
    try {
      root.renderer.flush()
      const viewport = await automation.getByTestId('settings-scroll').bounds()
      const row = await automation.getByTestId('settings-global-row').bounds()
      const content = await automation.getByTestId('settings-global').bounds()
      expect(row.x).toBeGreaterThanOrEqual(viewport.x)
      expect(content.x).toBeGreaterThan(viewport.x)
      expect(viewport.x + viewport.width - content.x - content.width).toBeGreaterThan(0)
      expect(Math.abs((content.x - viewport.x) - (viewport.x + viewport.width - content.x - content.width))).toBeLessThanOrEqual(1)
    } finally {
      await automation.close()
      root.unmount()
    }
  })

  it('subscribes terminal settings to state changes instead of PTY frame updates', async () => {
    let broadSubscriptions = 0
    let stateSubscriptions = 0
    const snapshot = { appearance: DEFAULT_TERMINAL_APPEARANCE }
    const terminals = {
      subscribe() { broadSubscriptions += 1; return () => undefined },
      subscribeState() { stateSubscriptions += 1; return () => undefined },
      getSnapshot() { return snapshot },
      getStateSnapshot() { return snapshot },
    } as unknown as TerminalSessionService
    const root = createTestRoot({ width: 900, height: 900 })
    root.render(
      <SettingsView
        state={createInitialState('/tmp/settings-terminal-subscription')}
        controller={{ reconnect() {}, setThreadTitleSettings() {} } as unknown as WorkbenchControllerSurface}
        theme={{ mode: 'dark', resolved: 'dark', fonts: DEFAULT_INTERFACE_FONTS }}
        terminals={terminals}
        onThemeModeChange={() => undefined}
        onClose={() => undefined}
      />,
    )
    try {
      root.renderer.flush()
      expect(stateSubscriptions).toBe(1)
      expect(broadSubscriptions).toBe(0)
    } finally {
      root.unmount()
    }
  })

  it('does not rerender Settings for unrelated live controller updates', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/settings-render-stability', testControllerDependencies())
    const themeManager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
    let renders = 0
    const root = createTestRoot({ width: 1_000, height: 700 })
    root.render(
      <WorkbenchApp
        controller={controller}
        presenters={new Map()}
        ui={createTestUiRegistry(controller)}
        themeManager={themeManager}
        onSettingsRenderForTest={() => { renders += 1 }}
      />,
    )
    await controller.start()
    const automation = await connectTest(root.renderer)
    try {
      await controller.submit('/settings')
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await automation.getByTestId('settings-view').count()).toBe(1)
      const initialRenders = renders
      expect(initialRenders).toBeGreaterThan(0)

      controller.acceptAgentEvent({ type: 'agent_start' })
      controller.acceptAgentEvent({ type: 'tool_execution_start', toolCallId: 'settings-live-tool', toolName: 'bash', args: { command: 'printf live' } })
      controller.acceptAgentEvent({ type: 'tool_execution_end', toolCallId: 'settings-live-tool', toolName: 'bash', result: { content: [] }, isError: false })
      controller.acceptAgentEvent({ type: 'agent_end', messages: [{ role: 'assistant', content: [], stopReason: 'stop' }], willRetry: false })
      controller.acceptAgentEvent({ type: 'agent_settled' })
      await Bun.sleep(30)
      root.renderer.flush()

      expect(renders).toBe(initialRenders)
    } finally {
      await automation.close()
      root.unmount()
      themeManager.dispose()
      await controller.dispose()
    }
  })
})
