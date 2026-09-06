import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchKernel } from '../../src/core/kernel.ts'
import '../../src/workbench/events.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../../src/flows/plugin.ts'
import { createWorkspaceHost, hostConnectUrl, type WorkspaceHost } from '../../src/host/server.ts'
import { generateHostToken } from '../../src/host/token.ts'
import type { PiMessage, PiSessionState, RpcCommand, RpcRecord } from '../../src/pi/types.ts'
import type { PiSessionSummary } from '../../src/pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../../src/pi/transport.ts'
import {
  agentTransportToken,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  sessionCatalogToken,
  workbenchControllerToken,
} from '../../src/workbench/plugins.ts'
import type { SessionCatalogService } from '../../src/workbench/services.ts'
import type { WorkbenchController } from '../../src/workbench/controller.ts'

export const ALPHA_LATEST = 'LATEST_ALPHA_ANSWER stays at the tail of the long thread.'
export const BETA_LATEST = 'LATEST_BETA_ANSWER is the newest reply in the other thread.'
export const ALPHA_TITLE = 'Alpha fixture thread'
export const BETA_TITLE = 'Beta fixture thread'

export interface LongSessionHost {
  kernel: WorkbenchKernel
  controller: WorkbenchController
  host: WorkspaceHost
  connectUrl: string
  workspacePath: string
  alphaPath: string
  betaPath: string
  close(): Promise<void>
}

class LongSessionTransport implements AgentTransport {
  readonly #events = new Set<(event: RpcRecord) => void>()
  readonly #statuses = new Set<(status: TransportStatus) => void>()
  #current: 'alpha' | 'beta'

  constructor(
    private readonly sessions: { alpha: SessionBundle; beta: SessionBundle },
    initial: 'alpha' | 'beta' = 'alpha',
  ) {
    this.#current = initial
  }

  async start(): Promise<void> {
    this.#emitStatus({ state: 'running', pid: process.pid })
  }

  async stop(): Promise<void> {
    this.#emitStatus({ state: 'stopped' })
  }

  send(_record: RpcRecord): void {}

  getStderr(): string {
    return ''
  }

  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.#events.add(listener)
    return () => this.#events.delete(listener)
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.#statuses.add(listener)
    return () => this.#statuses.delete(listener)
  }

  async request<T = unknown>(command: RpcCommand): Promise<T> {
    const bundle = this.sessions[this.#current]
    switch (command.type) {
      case 'get_state':
        return {
          model: { id: 'fixture', provider: 'fixture', name: 'Fixture' },
          thinkingLevel: 'off',
          isStreaming: false,
          sessionId: bundle.id,
          sessionFile: bundle.path,
          sessionName: bundle.title,
        } satisfies PiSessionState as T
      case 'get_messages':
        return { messages: bundle.messages } as T
      case 'get_fork_messages':
        return { messages: [] } as T
      case 'get_available_models':
        return { models: [{ id: 'fixture', provider: 'fixture', name: 'Fixture' }] } as T
      case 'get_available_thinking_levels':
        return { levels: ['off'] } as T
      case 'get_session_stats':
        return { sessionId: bundle.id, totalMessages: bundle.messages.length, toolCalls: 3, cost: 0 } as T
      case 'get_commands':
        return { commands: [] } as T
      case 'switch_session': {
        const path = String(command.sessionPath ?? '')
        if (path === this.sessions.beta.path) this.#current = 'beta'
        else this.#current = 'alpha'
        return { cancelled: false } as T
      }
      case 'new_session':
        return { cancelled: false } as T
      case 'abort':
        return undefined as T
      default:
        return undefined as T
    }
  }

  #emitStatus(status: TransportStatus): void {
    for (const listener of this.#statuses) listener(status)
  }
}

interface SessionBundle {
  id: string
  path: string
  title: string
  messages: PiMessage[]
}

class FixtureCatalog implements SessionCatalogService {
  constructor(private readonly sessions: PiSessionSummary[]) {}

  cached(): PiSessionSummary[] {
    return this.sessions
  }

  async list(): Promise<PiSessionSummary[]> {
    return this.sessions
  }

  async createWorkspaceSession(cwd: string): Promise<PiSessionSummary> {
    return this.sessions[0] ?? {
      id: 'empty',
      path: join(cwd, 'empty.jsonl'),
      cwd,
      title: '(no messages)',
      firstMessage: '',
      messageCount: 0,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
    }
  }
}

export function writeLongSessionFiles(root: string): { alpha: SessionBundle; beta: SessionBundle; summaries: PiSessionSummary[] } {
  const directory = join(root, 'sessions')
  mkdirSync(directory, { recursive: true })
  const alpha = writeSession(directory, 'alpha', ALPHA_TITLE, alphaMessages())
  const beta = writeSession(directory, 'beta', BETA_TITLE, betaMessages())
  const now = Date.now()
  const summaries: PiSessionSummary[] = [
    {
      id: beta.id,
      path: beta.path,
      cwd: root,
      title: beta.title,
      firstMessage: 'Beta earlier prompt 0',
      messageCount: beta.messages.length,
      createdAt: now - 60_000,
      modifiedAt: now,
    },
    {
      id: alpha.id,
      path: alpha.path,
      cwd: root,
      title: alpha.title,
      firstMessage: 'Alpha earlier prompt 0',
      messageCount: alpha.messages.length,
      createdAt: now - 120_000,
      modifiedAt: now - 30_000,
    },
  ]
  return { alpha, beta, summaries }
}

export async function startLongSessionHost(options: { port?: number; hostname?: string } = {}): Promise<LongSessionHost> {
  const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-long-session-'))
  const files = writeLongSessionFiles(workspacePath)
  const transport = new LongSessionTransport(files)
  const kernel = new WorkbenchKernel()
  kernel.mount({
    id: 'long-session-transport',
    activate(ctx) {
      ctx.provide(agentTransportToken, transport)
      ctx.effect(() => async () => transport.stop())
      ctx.effect(() => transport.onEvent((event) => ctx.emit('agent/event', event)))
      ctx.effect(() => transport.onStatus((status) => ctx.emit('agent/status', status)))
    },
  })
  kernel.mount({
    id: 'long-session-catalog',
    activate(ctx) {
      ctx.provide(sessionCatalogToken, new FixtureCatalog(files.summaries))
    },
  })
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createWorkbenchControllerPlugin(workspacePath))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
  const controller = kernel.get(workbenchControllerToken)
  await controller.start()
  const host = createWorkspaceHost({
    controller,
    flows: kernel.get(flowRuntimeToken),
    workspacePath,
    port: options.port ?? 0,
    hostname: options.hostname ?? '127.0.0.1',
    token: generateHostToken(),
  })
  return {
    kernel,
    controller,
    host,
    connectUrl: hostConnectUrl(host),
    workspacePath,
    alphaPath: files.alpha.path,
    betaPath: files.beta.path,
    async close() {
      await host.close()
      await kernel.dispose()
    },
  }
}

function writeSession(directory: string, id: string, title: string, messages: PiMessage[]): SessionBundle {
  const path = join(directory, `${id}.jsonl`)
  const lines = [`${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd: directory })}`]
  let parentId: string | null = null
  for (const [index, message] of messages.entries()) {
    const entryId = `${id}-${index}`
    lines.push(JSON.stringify({ type: 'message', id: entryId, parentId, timestamp: message.timestamp, message }))
    parentId = entryId
  }
  lines.push(JSON.stringify({ type: 'session_info', name: title }))
  writeFileSync(path, `${lines.join('\n')}\n`)
  return { id, path, title, messages }
}

function turn(index: number, prefix: string, timestamp: number): PiMessage[] {
  return [
    { role: 'user', content: `${prefix} prompt ${index}`, timestamp },
    { role: 'assistant', content: [{ type: 'text', text: `${prefix} answer ${index}` }], timestamp: timestamp + 500 },
  ]
}

function alphaMessages(): PiMessage[] {
  const messages: PiMessage[] = []
  for (let index = 0; index < 40; index += 1) {
    messages.push(...turn(index, 'Alpha earlier', 1_700_000_000_000 + index * 2_000))
  }
  messages.push({ role: 'user', content: 'Inspect the repo and group the work.', timestamp: 1_700_000_100_000 })
  messages.push({
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'I will inspect the workspace, then run a tool.' },
      { type: 'text', text: 'I will inspect the workspace.' },
      { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'README.md' } },
    ],
    timestamp: 1_700_000_101_000,
  })
  messages.push({ role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: 'ok', timestamp: 1_700_000_102_000 })
  messages.push({
    role: 'assistant',
    content: [
      { type: 'text', text: 'Next I will patch the transcript.' },
      { type: 'toolCall', id: 'edit-1', name: 'edit', arguments: { path: 'src/ui/transcript.tsx' } },
    ],
    timestamp: 1_700_000_103_000,
  })
  messages.push({ role: 'toolResult', toolCallId: 'edit-1', toolName: 'edit', content: 'patched', timestamp: 1_700_000_104_000 })
  messages.push({
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'grep-1', name: 'grep', arguments: { pattern: 'Worked for' } }],
    timestamp: 1_700_000_105_000,
  })
  messages.push({ role: 'toolResult', toolCallId: 'grep-1', toolName: 'grep', content: 'matches', timestamp: 1_700_000_106_000 })
  messages.push({ role: 'assistant', content: ALPHA_LATEST, timestamp: 1_700_000_107_000 })
  return messages
}

function betaMessages(): PiMessage[] {
  const messages: PiMessage[] = []
  for (let index = 0; index < 40; index += 1) {
    messages.push(...turn(index, 'Beta earlier', 1_700_000_300_000 + index * 2_000))
  }
  messages.push({ role: 'user', content: 'Switch me to the other thread.', timestamp: 1_700_000_390_000 })
  messages.push({ role: 'assistant', content: BETA_LATEST, timestamp: 1_700_000_391_000 })
  return messages
}
