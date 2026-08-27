import { describe, expect, it } from 'bun:test'
import { PiSessionCatalog, type PiSessionSummary } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiMessage, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const sessions: PiSessionSummary[] = [
  { id: 'one', path: '/tmp/one.jsonl', cwd: '/tmp/project', title: 'First thread', firstMessage: 'First', messageCount: 1, createdAt: 1, modifiedAt: 1 },
  { id: 'two', path: '/tmp/two.jsonl', cwd: '/tmp/project-two', title: 'Second thread', firstMessage: 'Second', messageCount: 1, createdAt: 2, modifiedAt: 2 },
]

class StaticCatalog extends PiSessionCatalog {
  override async list(): Promise<PiSessionSummary[]> {
    return sessions
  }
}

class SwitchingTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  readonly sent: RpcRecord[] = []
  active = sessions[0]!
  #notifyDuringBootstrap = false
  #switchBarrier: Promise<void> | undefined

  async start(): Promise<void> { this.emitStatus({ state: 'running', pid: 1 }) }
  async stop(): Promise<void> { this.emitStatus({ state: 'stopped' }) }
  send(record: RpcRecord): void { this.sent.push(record) }
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  holdNextSwitch(): () => void {
    let release = () => {}
    this.#switchBarrier = new Promise<void>((resolve) => { release = resolve })
    return release
  }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'switch_session') {
      this.active = sessions.find((session) => session.path === command.sessionPath) ?? this.active
      this.emitEvent({ type: 'extension_ui_request', id: 'switch-wizard', method: 'notify', message: 'Session wizard' })
      this.#notifyDuringBootstrap = true
      const barrier = this.#switchBarrier
      this.#switchBarrier = undefined
      if (barrier) await barrier
      return { cancelled: false } as T
    }
    if (command.type === 'get_state') {
      if (this.#notifyDuringBootstrap) {
        this.#notifyDuringBootstrap = false
        this.emitEvent({ type: 'extension_ui_request', id: 'bootstrap-wizard', method: 'notify', message: 'Bootstrap wizard' })
      }
      return {
        model: null,
        thinkingLevel: 'off',
        isStreaming: false,
        sessionFile: this.active.path,
        sessionId: this.active.id,
        sessionName: this.active.title,
      } as T
    }
    if (command.type === 'get_messages') {
      const messages: PiMessage[] = [{ role: 'user', content: this.active.firstMessage, timestamp: this.active.modifiedAt }]
      return { messages } as T
    }
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { sessionFile: this.active.path, sessionId: this.active.id, totalMessages: 1 } as T
    return undefined as T
  }

  emitEvent(event: RpcRecord): void {
    for (const listener of this.events) listener(event)
  }

  private emitStatus(status: TransportStatus): void {
    for (const listener of this.statuses) listener(status)
  }
}

describe('clickable session switching', () => {
  it('switches the Pi RPC session and rehydrates the selected transcript', async () => {
    const transport = new SwitchingTransport()
    const controller = new WorkbenchController(transport, '/tmp/project', testControllerDependencies(new StaticCatalog()))
    try {
      await controller.start()
      expect(controller.getSnapshot().sessions.map((session) => session.title)).toEqual(['First thread', 'Second thread'])
      const observedNoticeCounts: number[] = []
      const unsubscribe = controller.subscribe(() => { observedNoticeCounts.push(controller.getSnapshot().notices.length) })
      await controller.switchSession(sessions[1]!)
      unsubscribe()
      expect(observedNoticeCounts).not.toContain(1)
      expect(controller.getSnapshot().notices).toEqual([])
      expect(controller.getSnapshot().session.sessionId).toBe('two')
      expect(controller.getSnapshot().workspacePath).toBe('/tmp/project-two')
      expect(controller.getSnapshot().messages[0]?.content).toBe('Second')
    } finally {
      await controller.dispose()
    }
  })

  it('removes stale dialogs before an asynchronous session switch can paint', async () => {
    const transport = new SwitchingTransport()
    const controller = new WorkbenchController(transport, '/tmp/project', testControllerDependencies(new StaticCatalog()))
    try {
      await controller.start()
      transport.emitEvent({ type: 'extension_ui_request', id: 'stale-dialog', method: 'select', title: 'Old session action', options: ['Continue'] })
      expect(controller.getSnapshot().dialog?.id).toBe('stale-dialog')

      const release = transport.holdNextSwitch()
      const observedDialogIds: Array<string | undefined> = []
      const unsubscribe = controller.subscribe(() => { observedDialogIds.push(controller.getSnapshot().dialog?.id) })
      const switching = controller.switchSession(sessions[1]!)
      try {
        expect(controller.getSnapshot().dialog).toBeUndefined()
        expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'stale-dialog', cancelled: true })

        transport.emitEvent({ type: 'extension_ui_request', id: 'transition-dialog', method: 'confirm', title: 'Transition action' })
        expect(controller.getSnapshot().dialog).toBeUndefined()
        expect(transport.sent).toContainEqual({ type: 'extension_ui_response', id: 'transition-dialog', cancelled: true })
      } finally {
        release()
        await switching
        unsubscribe()
      }

      expect(observedDialogIds).not.toContain('stale-dialog')
      expect(observedDialogIds).not.toContain('transition-dialog')
      expect(controller.getSnapshot().session.sessionId).toBe('two')
    } finally {
      await controller.dispose()
    }
  })
})
