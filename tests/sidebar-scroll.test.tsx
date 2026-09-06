import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { WorkbenchSidebar } from '../src/ui/sidebar.tsx'
import { SIDEBAR_VIRTUAL_WINDOW_SIZE } from '../src/ui/virtual-window.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const now = Date.now()
const sessions = Array.from({ length: 40 }, (_, index): PiSessionSummary => ({
  id: `session-${index}`,
  path: `/tmp/session-${index}.jsonl`,
  cwd: '/tmp/project',
  title: `Thread ${index}`,
  firstMessage: `Prompt ${index}`,
  messageCount: 2,
  createdAt: now - index * 1_000,
  modifiedAt: now - index * 1_000,
}))

describeNative('sidebar initial session position', () => {
  it('resets to the top after initial hydration without disrupting later user scrolling', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/project', testControllerDependencies())
    const root = createTestRoot()
    const render = (state: ReturnType<typeof createInitialState>) => root.render(
      <WorkbenchSidebar
        state={state}
        controller={controller}
        settingsActive={false}
        notificationsActive={false}
        unreadCount={0}
        onSelectSession={() => undefined}
        onSettings={() => undefined}
        onNotifications={() => undefined}
      />,
    )

    try {
      render({ ...createInitialState('/tmp/project'), sessions, sessionsLoading: true })
      await Bun.sleep(0)
      root.renderer.flush()
      const automation = await connectTest(root.renderer)
      // Loading must not dim the list: native sidebars stay at full opacity while their contents settle.
      expect(root.renderer.findByTestId('sidebar-session-region')?.style.opacity ?? 1).toBe(1)
      const list = root.renderer.findByTestId('sidebar-session-list')!
      root.renderer.scrollTo(list.id, 0, -1_000)
      expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeLessThan(-100)

      render({ ...createInitialState('/tmp/project'), sessions, sessionsLoading: false })
      await Bun.sleep(0)
      root.renderer.flush()
      expect(root.renderer.findByTestId('sidebar-session-region')?.style.opacity ?? 1).toBe(1)
      expect(Math.abs(root.renderer.getScrollOffset(list.id)?.[1] ?? 0)).toBeLessThanOrEqual(0.01)
      await Bun.sleep(0)
      root.renderer.flush()
      expect(root.renderer.findByTestId('sidebar-scroll-fade-top')).toBeUndefined()
      expect(root.renderer.findByTestId('sidebar-scroll-fade-bottom')).toBeUndefined()

      root.renderer.scrollTo(list.id, 0, -500)
      const userOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
      expect(userOffset).toBeLessThan(-100)
      const laterSessions = [...sessions, ...sessions.slice(0, 5).map((session, index) => ({ ...session, id: `later-${index}`, path: `/tmp/later-${index}.jsonl` }))]
      render({ ...createInitialState('/tmp/project'), sessions: laterSessions, sessionsLoading: false })
      await Bun.sleep(0)
      root.renderer.flush()
      await Bun.sleep(0)
      root.renderer.flush()
      expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeLessThan(-100)
      root.renderer.scrollTo(list.id, 0, -10_000)
      render({ ...createInitialState('/tmp/project'), sessions: [...laterSessions, { ...sessions[0]!, id: 'last', path: '/tmp/last.jsonl' }], sessionsLoading: false })
      await Bun.sleep(0)
      root.renderer.flush()
      await Bun.sleep(0)
      root.renderer.flush()
      await automation.close()
    } finally {
      root.unmount()
      await controller.dispose()
    }
  })

  it('keeps settled history collapsed until its muted shelf is expanded', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/project', testControllerDependencies())
    const root = createTestRoot()
    const settledSessions = sessions.slice(0, 3).map((session, index) => ({
      ...session,
      id: `settled-${index}`,
      path: `/tmp/settled-${index}.jsonl`,
      modifiedAt: now - (8 + index) * 24 * 60 * 60 * 1_000,
    }))
    try {
      root.render(
        <WorkbenchSidebar
          state={{ ...createInitialState('/tmp/project'), sessions: settledSessions }}
          controller={controller}
          settingsActive={false}
          notificationsActive={false}
          unreadCount={0}
          onSelectSession={() => undefined}
          onSettings={() => undefined}
          onNotifications={() => undefined}
        />,
      )
      const automation = await connectTest(root.renderer)
      expect(await automation.getByTestId('sidebar-settled-toggle').count()).toBe(1)
      expect(root.renderer.getPaintedText()).toContain('Settled (3)')
      expect(await automation.getByTestId('sidebar-settled-row').count()).toBe(0)

      await automation.getByTestId('sidebar-settled-toggle').click()
      await Bun.sleep(0)
      root.renderer.flush()
      expect(root.renderer.getPaintedText()).toContain('Settled')
      expect(root.renderer.getPaintedText()).not.toContain('Settled (3)')
      expect(await automation.getByTestId('sidebar-settled-row').count()).toBe(3)
      const titles = root.renderer.findByType('text').filter((element) => element.testId === 'sidebar-settled-title')
      expect(titles.every((title) => title.style.color === '#595A5D')).toBe(true)

      await automation.getByTestId('sidebar-settled-toggle').click()
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await automation.getByTestId('sidebar-settled-row').count()).toBe(0)
      await automation.close()
    } finally {
      root.unmount()
      await controller.dispose()
    }
  })

  it('windows a 400-thread sidebar instead of mounting every row', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/project', testControllerDependencies())
    const many = Array.from({ length: 400 }, (_, index): PiSessionSummary => ({
      id: `many-${index}`,
      path: `/tmp/many-${index}.jsonl`,
      cwd: '/tmp/project',
      title: `Thread ${index}`,
      firstMessage: `Prompt ${index}`,
      messageCount: 2,
      createdAt: now - index * 1_000,
      modifiedAt: now - index * 1_000,
    }))
    const root = createTestRoot()
    try {
      root.render(
        <WorkbenchSidebar
          state={{ ...createInitialState('/tmp/project'), sessions: many }}
          controller={controller}
          settingsActive={false}
          notificationsActive={false}
          unreadCount={0}
          onSelectSession={() => undefined}
          onSettings={() => undefined}
          onNotifications={() => undefined}
        />,
      )
      const automation = await connectTest(root.renderer)
      const list = root.renderer.findByTestId('sidebar-session-list')!
      expect(Number(list.customProps?.itemCount ?? 0)).toBe(400)
      expect(list.children.length).toBeLessThanOrEqual(SIDEBAR_VIRTUAL_WINDOW_SIZE + 4)
      expect(root.renderer.getPaintedText()).toContain('Thread 0')
      root.renderer.scrollToItem(list.id, 399)
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(list.children.length).toBeLessThanOrEqual(SIDEBAR_VIRTUAL_WINDOW_SIZE + 4)
      expect(await automation.getByText('Thread 399').count()).toBe(1)
      await automation.close()
    } finally {
      root.unmount()
      await controller.dispose()
    }
  })
})
