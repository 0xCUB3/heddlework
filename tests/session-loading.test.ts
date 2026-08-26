import { describe, expect, it } from 'bun:test'
import { PiSessionCatalog, type PiSessionSummary } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { RpcCommand, RpcRecord } from '../src/pi/types.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

const sessions = Array.from({ length: 260 }, (_, index): PiSessionSummary => ({
  id: `session-${index}`,
  path: `/tmp/session-${index}.jsonl`,
  cwd: `/tmp/project-${index % 3}`,
  title: `Thread ${index}`,
  firstMessage: `Prompt ${index}`,
  messageCount: 1,
  createdAt: 260 - index,
  modifiedAt: 260 - index,
}))

class PagedCatalog extends PiSessionCatalog {
  readonly limits: number[] = []

  override async list(_cwd: string, limit?: number): Promise<PiSessionSummary[]> {
    this.limits.push(limit ?? sessions.length)
    return sessions.slice(0, limit)
  }
}

class DeferredTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  #releaseStart: (() => void) | undefined
  #startGate = new Promise<void>((resolve) => { this.#releaseStart = resolve })

  release(): void { this.#releaseStart?.() }
  async start(): Promise<void> { await this.#startGate }
  async stop(): Promise<void> {}
  send(): void {}
  getStderr(): string { return '' }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.events.add(listener); return () => this.events.delete(listener) }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.statuses.add(listener); return () => this.statuses.delete(listener) }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'get_state') return { model: null, thinkingLevel: 'off', isStreaming: false, sessionFile: sessions[0]!.path, sessionId: sessions[0]!.id } as T
    if (command.type === 'get_messages') return { messages: [] } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { totalMessages: 0 } as T
    if (command.type === 'get_fork_messages') return { messages: [] } as T
    return undefined as T
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(2)
  }
  throw new Error('Condition did not settle')
}

describe('session history startup and paging', () => {
  it('publishes persisted sessions before the Pi process finishes starting', async () => {
    const transport = new DeferredTransport()
    const catalog = new PagedCatalog()
    const controller = new WorkbenchController(transport, '/tmp/project-0', catalog)
    const starting = controller.start()
    try {
      await waitFor(() => controller.getSnapshot().sessions.length > 0)
      expect(controller.getSnapshot()).toMatchObject({ connection: 'connecting', sessionsLoading: false })
      expect(controller.getSnapshot().sessions).toHaveLength(120)
      expect(catalog.limits[0]).toBe(121)
      transport.release()
      await starting
    } finally {
      transport.release()
      await starting.catch(() => undefined)
      await controller.dispose()
    }
  })

  it('loads the global catalog in bounded pages', async () => {
    const transport = new DeferredTransport()
    const catalog = new PagedCatalog()
    const controller = new WorkbenchController(transport, '/tmp/project-0', catalog)
    transport.release()
    try {
      await controller.start()
      expect(controller.getSnapshot().sessions).toHaveLength(120)
      expect(controller.getSnapshot().sessionsHasMore).toBe(true)
      await controller.loadMoreSessions()
      expect(controller.getSnapshot().sessions).toHaveLength(240)
      expect(controller.getSnapshot().sessionsHasMore).toBe(true)
      await controller.loadMoreSessions()
      expect(controller.getSnapshot().sessions).toHaveLength(260)
      expect(controller.getSnapshot().sessionsHasMore).toBe(false)
      expect(catalog.limits).toEqual([121, 241, 361])
    } finally {
      await controller.dispose()
    }
  })
})
