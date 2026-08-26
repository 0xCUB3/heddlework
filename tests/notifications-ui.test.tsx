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
import { ComposerNotificationStack, NOTIFICATION_DISMISS_MS, NOTIFICATION_STACK_FADE_MS } from '../src/ui/notifications.tsx'

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

    await Bun.sleep(NOTIFICATION_STACK_FADE_MS + 150)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-stack-item').count()).toBe(0)
    expect(await automation.getByTestId('notification-toast').count()).toBe(1)
    expect(controller.getSnapshot().notices).toHaveLength(2)

    await automation.getByTestId('dismiss-toast').click()
    expect(await automation.getByTestId('notification-toast').count()).toBe(1)
    await Bun.sleep(NOTIFICATION_DISMISS_MS + 60)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-toast').count()).toBe(0)
    await automation.getByTestId('sidebar-notifications').click()
    expect(await automation.getByTestId('notification-panel').count()).toBe(1)
    expect((await automation.getByTestId('notification-panel').bounds()).width).toBe(420)
    expect(root.renderer.getPaintedText()).toContain('Notifications')
    expect(root.renderer.getPaintedText()).toContain('Thread moved to Settled')
    expect(root.renderer.getPaintedText()).not.toContain('Clear all')
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

    await automation.close()
    root.unmount()
  }, 10_000)

  it('tightly overlaps cards and fades the newest out while pulling its predecessor forward', async () => {
    const root = createTestRoot()
    const first = { id: 1, kind: 'info' as const, message: 'First notification', createdAt: Date.now() }
    const second = { id: 2, kind: 'warning' as const, message: 'Second notification', createdAt: Date.now() + 1 }
    root.render(<ComposerNotificationStack notices={[first]} />)
    await Bun.sleep(25)
    root.renderer.flush()
    root.render(<ComposerNotificationStack notices={[first, second]} />)
    await Bun.sleep(25)
    root.renderer.flush()
    const automation = await connectTest(root.renderer)

    const olderBounds = await automation.getByTestId('notification-stack-item').bounds()
    const newestBounds = await automation.getByTestId('notification-toast').bounds()
    expect(newestBounds.y - olderBounds.y).toBeLessThanOrEqual(20)
    expect(newestBounds.y).toBeGreaterThan(olderBounds.y)

    await automation.getByTestId('dismiss-toast').click()
    await Bun.sleep(70)
    root.renderer.flush()
    const fading = (await automation.getByTestId('notification-toast').all())[0]!
    expect(fading.style?.opacity as number).toBeGreaterThan(0)
    expect(fading.style?.opacity as number).toBeLessThan(1)
    expect(fading.bounds!.height).toBeLessThan(40)

    await Bun.sleep(NOTIFICATION_DISMISS_MS + 60)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-stack-item').count()).toBe(0)
    expect(await automation.getByTestId('notification-toast').count()).toBe(1)
    expect(root.renderer.getPaintedText()).toContain('First notification')
    expect(root.renderer.getPaintedText()).not.toContain('Second notification')

    await automation.close()
    root.unmount()
  })

  it('smoothly reveals the hidden end of an overflowing notice', async () => {
    const root = createTestRoot()
    const message = 'This overflowing notification smoothly reveals its hidden ending, then starts over.'
    root.render(
      <div style={{ width: 300 }}>
        <ComposerNotificationStack notices={[{ id: 1, kind: 'info', message, createdAt: Date.now() }]} />
      </div>,
    )
    const automation = await connectTest(root.renderer)
    await Bun.sleep(50)
    root.renderer.flush()

    const scrollNode = (await automation.getByTestId('notification-toast-scroll').all())[0]!
    expect(root.renderer.getScrollOffset(scrollNode.id)?.[0]).toBe(0)
    await Bun.sleep(1_100)
    root.renderer.flush()
    expect(root.renderer.getScrollOffset(scrollNode.id)?.[0] ?? 0).toBeLessThan(-5)
    expect(await automation.getByText(message).count()).toBe(1)

    const resetDeadline = Date.now() + 8_000
    while ((root.renderer.getScrollOffset(scrollNode.id)?.[0] ?? 0) !== 0 && Date.now() < resetDeadline) {
      await Bun.sleep(80)
      root.renderer.flush()
    }
    expect(root.renderer.getScrollOffset(scrollNode.id)?.[0]).toBe(0)

    await automation.close()
    root.unmount()
  }, 12_000)
})
