import { describe, expect, it } from 'bun:test'
import { PiSessionCatalog, type PiSessionSummary } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiMessage, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

const sessions: PiSessionSummary[] = [
  { id: 'one', path: '/tmp/one.jsonl', cwd: '/tmp/project', title: 'First thread', firstMessage: 'First', messageCount: 1, createdAt: 1, modifiedAt: 1 },
  { id: 'two', path: '/tmp/two.jsonl', cwd: '/tmp/project', title: 'Second thread', firstMessage: 'Second', messageCount: 1, createdAt: 2, modifiedAt: 2 },
]

class StaticCatalog extends PiSessionCatalog {
  override async list(): Promise<PiSessionSummary[]> {
    return sessions
  }
}

class SwitchingTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  active = sessions[0]!

  async start(): Promise<void> { this.emitStatus({ state: 'running', pid: 1 }) }
  async stop(): Promise<void> { this.emitStatus({ state: 'stopped' }) }
  send(): void {}
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'switch_session') {
      this.active = sessions.find((session) => session.path === command.sessionPath) ?? this.active
      return { cancelled: false } as T
    }
    if (command.type === 'get_state') {
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

  private emitStatus(status: TransportStatus): void {
    for (const listener of this.statuses) listener(status)
  }
}

describe('clickable session switching', () => {
  it('switches the Pi RPC session and rehydrates the selected transcript', async () => {
    const transport = new SwitchingTransport()
    const controller = new WorkbenchController(transport, '/tmp/project', new StaticCatalog())
    try {
      await controller.start()
      expect(controller.getSnapshot().sessions.map((session) => session.title)).toEqual(['First thread', 'Second thread'])
      await controller.switchSession(sessions[1]!)
      expect(controller.getSnapshot().session.sessionId).toBe('two')
      expect(controller.getSnapshot().messages[0]?.content).toBe('Second')
    } finally {
      await controller.dispose()
    }
  })
})
