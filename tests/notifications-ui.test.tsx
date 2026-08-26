import React from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { NOTIFICATION_TOAST_DURATION_MS } from '../src/ui/notifications.tsx'

const controllers: WorkbenchController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('notification surfaces', () => {
  it('hides the toast after two seconds but retains the event in the ledger', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/notification-workspace')
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
    const screenshotDirectory = resolve(import.meta.dir, '../screenshots')
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-notification.png')
      mkdirSync(screenshotDirectory, { recursive: true })
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    await Bun.sleep(NOTIFICATION_TOAST_DURATION_MS + 150)
    root.renderer.flush()
    expect(await automation.getByTestId('notification-toast').count()).toBe(0)
    expect(controller.getSnapshot().notices).toHaveLength(1)

    await automation.getByTestId('sidebar-notifications').click()
    expect(root.renderer.getPaintedText()).toContain('Notifications')
    expect(root.renderer.getPaintedText()).toContain('Thread moved to Settled')
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-notification-ledger.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    await automation.close()
    root.unmount()
  }, 10_000)
})
