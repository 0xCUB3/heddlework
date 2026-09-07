import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiSessionCatalog, type PiSessionSummary } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiMessage, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

class OneSessionCatalog extends PiSessionCatalog {
  constructor(private readonly session: PiSessionSummary) { super() }
  override async list(): Promise<PiSessionSummary[]> { return [this.session] }
}

class TailOnlyTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()

  constructor(
    private readonly sessionPath: string,
    private readonly tail: PiMessage[],
  ) {}

  async start(): Promise<void> { this.emitStatus({ state: 'running', pid: 1 }) }
  async stop(): Promise<void> { this.emitStatus({ state: 'stopped' }) }
  send(): void {}
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'get_state') return {
      model: null,
      thinkingLevel: 'off',
      isStreaming: false,
      sessionFile: this.sessionPath,
      sessionId: 'paged-session',
      sessionName: 'Paged session',
    } as T
    if (command.type === 'get_messages') return { messages: this.tail } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { sessionFile: this.sessionPath, sessionId: 'paged-session', totalMessages: 100 } as T
    return undefined as T
  }

  private emitStatus(status: TransportStatus): void {
    for (const listener of this.statuses) listener(status)
  }
}

describe('controller-backed persisted history', () => {
  it('starts with one bounded persisted page and prepends older JSONL history', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-history-controller-'))
    fixtures.push(directory)
    const sessionPath = join(directory, 'session.jsonl')
    const records: Record<string, unknown>[] = [{
      type: 'session',
      version: 3,
      id: 'paged-session',
      timestamp: '2026-01-01T00:00:00.000Z',
      cwd: directory,
    }]
    const messages: PiMessage[] = []
    let parentId: string | null = null
    for (let index = 0; index < 100; index += 1) {
      const id = `message-${index}`
      const role = index % 2 === 0 ? 'user' : 'assistant'
      const message = { role, content: `${role} ${index}`, timestamp: index + 1 } as PiMessage
      messages.push(message)
      records.push({ type: 'message', id, parentId, timestamp: new Date(index + 1).toISOString(), message })
      parentId = id
    }
    await writeFile(sessionPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')

    const summary: PiSessionSummary = {
      id: 'paged-session',
      path: sessionPath,
      cwd: directory,
      title: 'Paged session',
      firstMessage: 'user 0',
      messageCount: 100,
      createdAt: 1,
      modifiedAt: 100,
    }
    const controller = new WorkbenchController(
      new TailOnlyTransport(sessionPath, messages.slice(-20)),
      directory,
      testControllerDependencies(new OneSessionCatalog(summary)),
    )
    try {
      await controller.start()
      expect(controller.getSnapshot().messages).toHaveLength(80)
      expect(controller.getSnapshot().messages[0]?.content).toBe('user 20')
      expect(controller.getSnapshot()).toMatchObject({ messagesHasOlder: true, messagesLoadingEarlier: false })

      await controller.loadEarlierMessages()

      expect(controller.getSnapshot().messages).toHaveLength(100)
      expect(controller.getSnapshot().messages[0]?.content).toBe('user 0')
      expect(controller.getSnapshot()).toMatchObject({ messagesHasOlder: false, messagesLoadingEarlier: false })
    } finally {
      await controller.dispose()
    }
  })

  it('serves the live transcript while the announced session file does not exist yet, then attaches the pager', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-history-controller-'))
    fixtures.push(directory)
    const sessionPath = join(directory, 'not-yet-written.jsonl')
    const live: PiMessage[] = [{ role: 'user', content: 'first ask', timestamp: 1 } as PiMessage]
    const transport = new TailOnlyTransport(sessionPath, live)
    const summary: PiSessionSummary = { id: 'paged-session', path: sessionPath, cwd: directory, title: 'Fresh', firstMessage: 'first ask', messageCount: 1, createdAt: 1, modifiedAt: 1 }
    const controller = new WorkbenchController(transport, directory, testControllerDependencies(new OneSessionCatalog(summary)))
    try {
      await controller.start()
      expect(controller.getSnapshot().messages.map((message) => message.content)).toEqual(['first ask'])
      expect(controller.getSnapshot().notices.filter((notice) => notice.message.includes('Could not refresh transcript'))).toEqual([])
      expect(controller.getSnapshot().messagesHasOlder).toBe(false)

      // Pi flushes the file on the first reply; the next refresh should read it and expose the older page.
      const records: Record<string, unknown>[] = [{ type: 'session', version: 3, id: 'paged-session', timestamp: '2026-01-01T00:00:00.000Z', cwd: directory }]
      let parentId: string | null = null
      for (let index = 0; index < 90; index += 1) {
        const id = `message-${index}`
        const role = index % 2 === 0 ? 'user' : 'assistant'
        records.push({ type: 'message', id, parentId, timestamp: new Date(index + 1).toISOString(), message: { role, content: `${role} ${index}`, timestamp: index + 1 } })
        parentId = id
      }
      await writeFile(sessionPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n')
      for (const listener of transport.events) listener({ type: 'message_end' })
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(controller.getSnapshot().messages).toHaveLength(80)
      expect(controller.getSnapshot().messagesHasOlder).toBe(true)
      expect(controller.getSnapshot().notices.filter((notice) => notice.message.includes('Could not refresh transcript'))).toEqual([])
    } finally {
      await controller.dispose()
    }
  })
})
