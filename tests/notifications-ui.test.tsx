import React from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { createInitialState } from '../src/workbench/state.ts'
import { ComposerNotificationStack, NotificationLedgerView, composerNotificationStackHeight } from '../src/ui/notifications.tsx'

const controllers: WorkbenchController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('notification surfaces', () => {
  it('pins the latest notice above the composer and keeps an immutable balanced ledger', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/notification-workspace', new PiSessionCatalog({ scope: 'cwd' }))
    controllers.push(controller)
    const root = createTestRoot()
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} />)
    await controller.start()
    const automation = await connectTest(root.renderer)

    controller.settleThread('fixture-thread')
    await Bun.sleep(40)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-toast').count()).toBe(1)
    expect(controller.getSnapshot().notices).toHaveLength(1)
    const toastBounds = await automation.getByTestId('notification-toast').bounds()
    const composerBounds = await automation.getByTestId('composer-surface').bounds()
    expect(toastBounds.y + toastBounds.height).toBeLessThanOrEqual(composerBounds.y)
    expect(toastBounds.height).toBeLessThanOrEqual(40)
    expect(await automation.getByText('Workbench update').count()).toBe(0)
    const toastMessage = await automation.getByTestId('notification-toast-message').bounds()
    root.renderer.dragSelect(toastMessage.x + 2, toastMessage.y + toastMessage.height / 2, toastMessage.x + toastMessage.width - 2, toastMessage.y + toastMessage.height / 2)
    expect(root.renderer.getSelectedText()?.length ?? 0).toBeGreaterThan(0)

    const screenshotDirectory = resolve(import.meta.dir, '../screenshots')
    if (process.platform === 'darwin') {
      mkdirSync(screenshotDirectory, { recursive: true })
      const screenshot = resolve(screenshotDirectory, 'workbench-notification.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    root.renderer.clearSelection()
    controller.settleThread('fixture-thread-two')
    await Bun.sleep(40)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-stack-item').count()).toBe(1)
    expect(await automation.getByTestId('notification-toast').count()).toBe(1)

    await Bun.sleep(2_350)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-stack-item').count()).toBe(1)
    expect(await automation.getByTestId('notification-toast').count()).toBe(1)
    expect(controller.getSnapshot().notices).toHaveLength(2)

    await automation.getByTestId('sidebar-notifications').click()
    expect(await automation.getByTestId('notification-panel').count()).toBe(1)
    expect((await automation.getByTestId('notification-panel').bounds()).width).toBe(420)
    expect(root.renderer.getPaintedText()).toContain('Notifications')
    expect(root.renderer.getPaintedText()).toContain('Thread moved to Settled')
    expect(root.renderer.getPaintedText()).toContain('Clear all')
    expect(await automation.getByTestId('clear-notification-ledger').count()).toBe(1)
    expect(await automation.getByTestId('close-notifications').count()).toBe(0)
    const panelBounds = await automation.getByTestId('notification-panel').bounds()
    const rowBounds = (await automation.getByTestId('notification-ledger-row').all())[0]!.bounds!
    expect(rowBounds.height).toBeLessThanOrEqual(44)
    const leftInset = rowBounds.x - panelBounds.x
    const rightInset = panelBounds.x + panelBounds.width - rowBounds.x - rowBounds.width
    expect(Math.abs(leftInset - rightInset - 24)).toBeLessThanOrEqual(2)

    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-notification-ledger.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    controller.clearNotices()
    await Bun.sleep(25)
    root.renderer.flush()
    expect(controller.getSnapshot().notices).toHaveLength(0)
    expect(root.renderer.getPaintedText()).toContain('No notifications yet')

    await automation.getByTestId('sidebar-notifications').click()
    controller.settleThread('fixture-thread-three')
    await Bun.sleep(25)
    root.renderer.flush()
    await automation.getByTestId('clear-notifications').click()
    await Bun.sleep(25)
    root.renderer.flush()
    expect(controller.getSnapshot().notices).toHaveLength(0)
    expect(await automation.getByTestId('notification-toast').count()).toBe(0)

    await automation.close()
    root.unmount()
  }, 10_000)

  it('dispatches the ledger clear-all control', async () => {
    const root = createTestRoot()
    let clears = 0
    const state = { ...createInitialState('/tmp/notices'), notices: [{ id: 1, kind: 'info' as const, message: 'Saved notice', createdAt: 1 }] }
    root.render(<NotificationLedgerView state={state} onClear={() => { clears += 1 }} />)
    const automation = await connectTest(root.renderer)
    await automation.getByTestId('clear-notification-ledger').click()
    expect(clears).toBe(1)
    await automation.close()
    root.unmount()
  })

  it('keeps a compact persistent stack of the latest three notices', async () => {
    const root = createTestRoot()
    let clears = 0
    const notices = Array.from({ length: 4 }, (_, index) => ({
      id: index + 1,
      kind: (index % 2 === 0 ? 'info' : 'warning') as 'info' | 'warning',
      message: `Notification ${index + 1}`,
      createdAt: Date.now() + index,
    }))
    function StackFixture() {
      const [current, setCurrent] = React.useState(notices)
      return <ComposerNotificationStack notices={current} onDismiss={(id) => setCurrent((items) => items.filter((item) => item.id !== id))} onClear={() => { clears += 1; setCurrent([]) }} />
    }
    root.render(<StackFixture />)
    const automation = await connectTest(root.renderer)

    expect(await automation.getByTestId('notification-stack-item').count()).toBe(2)
    expect(await automation.getByTestId('notification-toast').count()).toBe(1)
    expect(root.renderer.getPaintedText()).not.toContain('Notification 1')
    expect(root.renderer.getPaintedText()).toContain('Notification 2')
    expect(await automation.getByTestId('clear-notifications-icon').count()).toBe(1)
    expect(await automation.getByTestId('dismiss-notification:2').count()).toBe(1)
    expect(await automation.getByTestId('dismiss-notification:3').count()).toBe(1)
    expect(await automation.getByTestId('dismiss-notification:4').count()).toBe(1)
    const cards = await automation.getByTestId('notification-stack-item').all()
    const newestBounds = await automation.getByTestId('notification-toast').bounds()
    expect(newestBounds.y - cards[0]!.bounds!.y).toBeLessThan(40)
    expect(composerNotificationStackHeight(4)).toBe(84)

    await automation.getByTestId('dismiss-notification:4').click()
    root.renderer.flush()
    const exiting = (await automation.getByTestId('notification-toast').all())[0]!
    expect((exiting.customProps?.motion as { animate: { opacity: number; left: number } }).animate).toEqual({ opacity: 0, left: 18 })
    expect(root.renderer.getPaintedText()).not.toContain('Notification 1')
    await Bun.sleep(220)
    root.renderer.flush()
    expect(root.renderer.getPaintedText()).not.toContain('Notification 4')
    expect(root.renderer.getPaintedText()).toContain('Notification 1')
    const replacement = (await automation.getByTestId('notification-stack-item').all())[0]!
    expect((replacement.customProps?.motion as { initial: { opacity: number; left: number } }).initial).toEqual({ opacity: 0, left: -10 })

    await Bun.sleep(2_500)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-stack-item').count()).toBe(2)
    await automation.getByTestId('clear-notifications').click()
    expect(clears).toBe(1)

    await automation.close()
    root.unmount()
  })

  it('clips overflowing notices without background scroll timers', async () => {
    const root = createTestRoot()
    const message = 'This overflowing notification remains compact without continuously mutating native scroll state.'
    root.render(
      <div style={{ width: 300 }}>
        <ComposerNotificationStack notices={[{ id: 1, kind: 'info', message, createdAt: Date.now() }]} onDismiss={() => {}} onClear={() => {}} />
      </div>,
    )
    const automation = await connectTest(root.renderer)
    const text = (await automation.getByTestId('notification-toast-message').all())[0]!
    expect(text.style?.textOverflow).toBe('ellipsis')
    await Bun.sleep(1_100)
    root.renderer.flush()
    const viewport = (await automation.getByTestId('notification-toast-scroll').all())[0]!
    expect(root.renderer.getScrollOffset(viewport.id)).toBeNull()
    expect(await automation.getByText(message).count()).toBe(1)

    await automation.close()
    root.unmount()
  })
})
