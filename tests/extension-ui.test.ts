import React from 'react'
import { describe, expect, it } from 'bun:test'
import { mkdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

class ManualTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  readonly sent: RpcRecord[] = []

  async start(): Promise<void> {
    this.emitStatus({ state: 'running', pid: 1 })
  }

  async stop(): Promise<void> {
    this.emitStatus({ state: 'stopped' })
  }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'get_state') return { model: null, thinkingLevel: 'off', isStreaming: false } as T
    if (command.type === 'get_messages') return { messages: [] } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { totalMessages: 0 } as T
    if (command.type === 'get_fork_messages') return { messages: [] } as T
    if (command.type === 'new_session') return { cancelled: false } as T
    return undefined as T
  }

  send(record: RpcRecord): void {
    this.sent.push(record)
  }

  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statuses.add(listener)
    return () => this.statuses.delete(listener)
  }

  getStderr(): string {
    return ''
  }

  emit(event: RpcRecord): void {
    for (const listener of this.events) listener(event)
  }

  emitStatus(status: TransportStatus): void {
    for (const listener of this.statuses) listener(status)
  }
}

describe('Pi extension UI projection', () => {
  it('projects fire-and-forget surfaces and responds to dialogs', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({ type: 'extension_ui_request', id: 'notify-1', method: 'notify', message: 'Heads up', notifyType: 'warning' })
      transport.emit({ type: 'extension_ui_request', id: 'status-1', method: 'setStatus', statusKey: 'tests', statusText: 'Running tests' })
      transport.emit({
        type: 'extension_ui_request',
        id: 'widget-1',
        method: 'setWidget',
        widgetKey: 'todo',
        widgetLines: ['One remaining task'],
        widgetPlacement: 'aboveEditor',
      })
      transport.emit({ type: 'extension_ui_request', id: 'title-1', method: 'setTitle', title: 'Pi · test session' })
      transport.emit({ type: 'extension_ui_request', id: 'editor-1', method: 'set_editor_text', text: 'prefilled prompt' })
      transport.emit({
        type: 'extension_ui_request',
        id: 'select-1',
        method: 'select',
        title: 'Choose',
        options: ['Allow', 'Block'],
      })

      const state = controller.getSnapshot()
      expect(state.notices.at(-1)).toMatchObject({ kind: 'warning', message: 'Heads up' })
      expect(state.statusItems.tests).toBe('Running tests')
      expect(state.widgets.todo?.lines).toEqual(['One remaining task'])
      expect(state.windowTitle).toBe('Pi · test session')
      expect(state.editorText).toBe('prefilled prompt')
      expect(state.dialog).toMatchObject({ id: 'select-1', method: 'select', options: ['Allow', 'Block'] })

      controller.respondToDialog({ value: 'Allow' })
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'select-1', value: 'Allow' })
      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(controller.getSnapshot().notices).toHaveLength(1)
    } finally {
      await controller.dispose()
    }
  })

  it('cancels an active dialog when a new session begins', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      transport.emit({
        type: 'extension_ui_request',
        id: 'stale-dialog',
        method: 'select',
        title: 'Old session action',
        options: ['Continue'],
      })
      transport.emit({ type: 'extension_ui_request', id: 'old-notice', method: 'notify', message: 'Old session notice' })
      expect(controller.getSnapshot().dialog?.id).toBe('stale-dialog')
      expect(controller.getSnapshot().notices).toHaveLength(1)

      await controller.newSession()

      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'stale-dialog', cancelled: true })
      expect(controller.getSnapshot().dialog).toBeUndefined()
      expect(controller.getSnapshot().notices).toHaveLength(0)
    } finally {
      await controller.dispose()
    }
  })
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('Pi extension dialog layout', () => {
  it('wraps a long title inside the composer panel', async () => {
    const transport = new ManualTransport()
    const controller = new WorkbenchController(transport, '/tmp/workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    const root = createTestRoot()
    root.render(React.createElement(WorkbenchApp, { controller, presenters: new Map(), ui: createTestUiRegistry(controller) }))
    await controller.start()
    const automation = await connectTest(root.renderer)
    try {
      transport.emit({
        type: 'extension_ui_request',
        id: 'long-dialog',
        method: 'select',
        title: '⏱ Extend billable human time? Idle after the agent. Add a 20m pomodoro block? · 27m still provisioned — extending adds more.',
        options: ['Extend +20m', 'Stop billing'],
      })
      await Bun.sleep(25)
      root.renderer.flush()

      const panelBounds = await automation.getByTestId('extension-dialog').bounds()
      const titleBounds = await automation.getByTestId('extension-dialog-title').bounds()
      expect(titleBounds.x + titleBounds.width).toBeLessThanOrEqual(panelBounds.x + panelBounds.width - 12)
      expect(titleBounds.height).toBeGreaterThan(17)

      if (process.platform === 'darwin') {
        const screenshotDirectory = resolve(import.meta.dir, '../screenshots')
        mkdirSync(screenshotDirectory, { recursive: true })
        const screenshot = resolve(screenshotDirectory, 'workbench-extension-dialog.png')
        root.renderer.captureScreenshot(screenshot)
        expect(statSync(screenshot).size).toBeGreaterThan(10_000)
      }

      await automation.getByTestId('sidebar-new-thread').click()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(await automation.getByTestId('extension-dialog').count()).toBe(0)
      expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'long-dialog', cancelled: true })
    } finally {
      await automation.close()
      root.unmount()
      await controller.dispose()
    }
  })
})
