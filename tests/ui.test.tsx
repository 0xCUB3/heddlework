import React from 'react'
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'

const controllers: WorkbenchController[] = []
afterEach(async () => {
  await Promise.all(controllers.splice(0).map((controller) => controller.dispose()))
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('WorkbenchApp', () => {
  it('renders the connected native workbench shell', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/example-workspace')
    controllers.push(controller)
    const root = createTestRoot()
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} />)
    await controller.start()
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} />)
    root.renderer.flush()

    const painted = root.renderer.getPaintedText()
    expect(painted).toContain('Pi Workbench')
    expect(painted).toContain('example-workspace')
    expect(painted).toContain('Demo session')
    expect(painted).toContain('Ask Pi to work on this repository…')
    expect(root.renderer.findByType('virtual-list')).toHaveLength(1)
    expect(root.renderer.findByType('textarea')).toHaveLength(1)
    const screenshotDirectory = resolve(import.meta.dir, '../screenshots')
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench.png')
      mkdirSync(screenshotDirectory, { recursive: true })
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }

    await controller.submit('Inspect the repository')
    await Bun.sleep(1_650)
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} />)
    root.renderer.flush()
    const conversation = root.renderer.getPaintedText()
    expect(conversation).toContain('Inspect the repository')
    expect(conversation).toContain('bash')
    expect(conversation.some((line) => line.includes('native GPUIX transcript'))).toBe(true)
    expect(root.renderer.findByType('code').length).toBeGreaterThan(0)
    if (process.platform === 'darwin') {
      const screenshot = resolve(screenshotDirectory, 'workbench-conversation.png')
      root.renderer.captureScreenshot(screenshot)
      expect(statSync(screenshot).size).toBeGreaterThan(10_000)
    }
    root.unmount()
  })
})
