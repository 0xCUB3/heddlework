import { describe, expect, it } from 'bun:test'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

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
    const controller = new WorkbenchController(transport, '/tmp/workspace', new PiSessionCatalog({ scope: 'cwd' }))
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
    } finally {
      await controller.dispose()
    }
  })
})
