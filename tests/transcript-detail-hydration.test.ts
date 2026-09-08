import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteWorkbenchController } from '../src/dom/remote-controller.ts'
import { FlowRuntime } from '../src/flows/runtime.ts'
import { createWorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { PiSessionCatalog, type PiSessionSummary } from '../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../src/pi/transport.ts'
import type { PiMessage, RpcCommand, RpcRecord } from '../src/pi/types.ts'
import {
  mergeTranscriptDetail,
  pageTranscriptDetail,
  serializeSnapshot,
} from '../src/protocol/index.ts'
import { WorkspaceClient } from '../src/web/client.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const fixtures: string[] = []

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

const FULL_OUTPUT = `${'full output line\n'.repeat(700)}tail-marker`

class StaticCatalog extends PiSessionCatalog {
  constructor(private readonly session: PiSessionSummary) {
    super()
  }
  override async list(): Promise<PiSessionSummary[]> {
    return [this.session]
  }
}

class DetailTransport implements AgentTransport {
  readonly events = new Set<(event: RpcRecord) => void>()
  readonly statuses = new Set<(status: TransportStatus) => void>()
  active: string
  readonly messagesByPath: Record<string, PiMessage[]>

  constructor(sessionPath: string, messages: PiMessage[], extras: Record<string, PiMessage[]> = {}) {
    this.active = sessionPath
    this.messagesByPath = { [sessionPath]: messages, ...extras }
  }

  async start(): Promise<void> {
    this.emitStatus({ state: 'running', pid: 1 })
  }
  async stop(): Promise<void> {
    this.emitStatus({ state: 'stopped' })
  }
  send(): void {}
  getStderr(): string {
    return ''
  }
  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.events.add(listener)
    return () => this.events.delete(listener)
  }
  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.statuses.add(listener)
    return () => this.statuses.delete(listener)
  }
  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (command.type === 'abort') return undefined as T
    if (command.type === 'switch_session') {
      this.active = String((command as { sessionPath?: string }).sessionPath ?? this.active)
      return { cancelled: false } as T
    }
    if (command.type === 'get_state') {
      return {
        model: null,
        thinkingLevel: 'off',
        isStreaming: false,
        sessionFile: this.active,
        sessionId: this.active.endsWith('beta.jsonl') ? 'beta' : 'alpha',
        sessionName: this.active.endsWith('beta.jsonl') ? 'Beta' : 'Alpha',
      } as T
    }
    if (command.type === 'get_messages') return { messages: this.messagesByPath[this.active] ?? [] } as T
    if (command.type === 'get_available_models') return { models: [] } as T
    if (command.type === 'get_available_thinking_levels') return { levels: ['off'] } as T
    if (command.type === 'get_session_stats') return { totalMessages: this.messagesByPath[this.active]?.length ?? 0 } as T
    if (command.type === 'get_fork_messages') return { messages: [] } as T
    return undefined as T
  }
  private emitStatus(status: TransportStatus): void {
    for (const listener of this.statuses) listener(status)
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting')
    await Bun.sleep(15)
  }
}

function toolThread(pathTag: string): PiMessage[] {
  return [
    { role: 'user', content: `Ask ${pathTag}`, timestamp: 1 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Working' }, { type: 'toolCall', id: `${pathTag}-call`, name: 'bash', arguments: { cmd: 'cat' } }],
      timestamp: 2,
    },
    {
      role: 'toolResult',
      toolCallId: `${pathTag}-call`,
      toolName: 'bash',
      content: FULL_OUTPUT,
      timestamp: 3,
    },
    { role: 'assistant', content: `Answer for ${pathTag}`, timestamp: 4 },
  ]
}

describe('transcript detail hydration', () => {
  it('adopts a 10KB body through host, client merge, and the app wrapper callback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-detail-hydrate-'))
    fixtures.push(directory)
    const sessionPath = join(directory, 'alpha.jsonl')
    const messages = toolThread('alpha')
    await writeSession(sessionPath, 'alpha', messages)
    const summary: PiSessionSummary = {
      id: 'alpha',
      path: sessionPath,
      cwd: directory,
      title: 'Alpha',
      firstMessage: 'Ask alpha',
      messageCount: messages.length,
      createdAt: 1,
      modifiedAt: 4,
    }
    const transport = new DetailTransport(sessionPath, messages)
    const controller = new WorkbenchController(transport, directory, testControllerDependencies(new StaticCatalog(summary)))
    await controller.start()
    const flows = new FlowRuntime(controller, { path: false, tickIntervalMs: 60_000 })
    const host = createWorkspaceHost({
      controller,
      flows,
      workspacePath: directory,
      port: 0,
      token: generateHostToken(),
    })
    const client = new WorkspaceClient()
    try {
      client.connect(host.url, host.token)
      await waitFor(() => client.getSnapshot().status === 'open' && (client.getSnapshot().state?.messages.length ?? 0) > 0)
      const stub = client.getSnapshot().state!.messages.find((message) => message.role === 'toolResult')
      const stubRef = (stub as { detailRef?: { omitted?: boolean; entryId?: string } } | undefined)?.detailRef
      expect(stubRef?.omitted).toBe(true)
      expect(String(stub?.content ?? '')).not.toContain('tail-marker')

      const remote = new RemoteWorkbenchController(client)
      const entryId = String(stubRef?.entryId ?? stub!.workbenchEntryId ?? stub!.toolCallId ?? '')
      expect(entryId).toBeTruthy()
      await remote.getTranscriptDetail(entryId).then(() => undefined)
      const adopted = client.getSnapshot().state!.messages.find((message) => message.role === 'toolResult')
      expect(String(adopted?.content ?? '')).toContain('tail-marker')
      expect((adopted as { detailRef?: unknown } | undefined)?.detailRef).toBeUndefined()

      await remote.getTranscriptDetail('alpha-call').then(() => undefined)
      const byCall = client.getSnapshot().state!.messages.find((message) => message.toolCallId === 'alpha-call')
      expect(String(byCall?.content ?? '')).toContain('tail-marker')
    } finally {
      client.disconnect()
      await host.close()
      await controller.dispose()
      flows.dispose()
    }
  }, 20_000)

  it('ignores a late detail page after the session switches', async () => {
    const stub: PiMessage = {
      role: 'assistant',
      workbenchEntryId: 'keep',
      content: 'preview…',
      timestamp: 1,
      detailRef: { entryId: 'keep', bytes: 12_000, omitted: true },
    }
    const full: PiMessage = { role: 'assistant', workbenchEntryId: 'keep', content: FULL_OUTPUT, timestamp: 1 }
    const page = pageTranscriptDetail({ kind: 'message', entryId: 'keep', message: full }, { offset: 0, sessionFile: '/tmp/a.jsonl' })
    const snapshot = serializeSnapshot({
      ...createInitialState('/tmp/b.jsonl'),
      session: { ...createInitialState('/tmp/b.jsonl').session, sessionFile: '/tmp/b.jsonl' },
      messages: [stub],
    })
    const merged = mergeTranscriptDetail(snapshot, page)
    expect(merged.messages[0]?.content).toBe('preview…')
  })
})

async function writeSession(path: string, id: string, messages: PiMessage[]): Promise<void> {
  const lines = [`${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' })}`]
  let parentId: string | null = null
  for (const [index, message] of messages.entries()) {
    const entryId = `${id}-${index}`
    lines.push(JSON.stringify({ type: 'message', id: entryId, parentId, timestamp: message.timestamp, message }))
    parentId = entryId
  }
  await writeFile(path, `${lines.join('\n')}\n`)
}
