import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntimeSessionFactory } from '../src/host/runtime-composition.ts'
import { createWorkspaceHost, type WorkspaceHost } from '../src/host/server.ts'
import { SessionRuntime } from '../src/host/session-runtime.ts'
import { generateHostToken } from '../src/host/token.ts'
import { getPiSessionDirectory, PiSessionCatalog, type PiSessionSummary } from '../src/pi/session-catalog.ts'
import { FrameAssembler, type ClientMessage, type ServerMessage } from '../src/protocol/index.ts'
import { sessionCatalogToken } from '../src/workbench/plugins.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

class TestClient {
  readonly socket: WebSocket
  readonly messages: ServerMessage[] = []
  readonly #frames = new FrameAssembler()
  readonly #waiters: Array<{ predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }> = []

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event) => {
      const assembled = this.#frames.push(String(event.data))
      if (assembled === undefined) return
      const message = (typeof assembled === 'string' ? JSON.parse(assembled) : assembled) as ServerMessage
      this.messages.push(message)
      for (const waiter of [...this.#waiters]) {
        if (waiter.predicate(message)) {
          this.#waiters.splice(this.#waiters.indexOf(waiter), 1)
          waiter.resolve(message)
        }
      }
    })
  }

  open(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', () => reject(new Error('socket error')))
    })
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message))
  }

  next(predicate: (message: ServerMessage) => boolean, timeoutMs = 8_000): Promise<ServerMessage> {
    const existing = this.messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for server message')), timeoutMs)
      this.#waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message) } })
    })
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.socket.addEventListener('close', () => resolve())
      this.socket.close()
    })
  }
}

function wsUrl(host: WorkspaceHost): string {
  return `${host.url.replace('http', 'ws')}/ws?token=${encodeURIComponent(host.token)}`
}

async function waitFor(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Condition was not met')
    await Bun.sleep(10)
  }
}

function header(id: string, cwd: string, timestamp = '2026-01-01T00:00:00.000Z'): string {
  return JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp }) + '\n'
}

function userLine(text: string, timestamp = '2026-01-01T00:01:00.000Z'): string {
  return JSON.stringify({ type: 'message', timestamp, message: { role: 'user', content: text, timestamp: Date.parse(timestamp) } }) + '\n'
}

function assistantLine(text: string, timestamp: string): string {
  return JSON.stringify({
    type: 'message',
    timestamp,
    message: { role: 'assistant', content: [{ type: 'text', text }], timestamp: Date.parse(timestamp), stopReason: 'stop' },
  }) + '\n'
}

function catalogFrom(client: TestClient): { sessions: PiSessionSummary[]; sessionFile: string | undefined } {
  let sessions: PiSessionSummary[] = []
  let sessionFile: string | undefined
  for (const message of client.messages) {
    if (message.kind === 'welcome') {
      sessions = message.snapshot.sessions
      sessionFile = message.snapshot.session.sessionFile
    }
    if (message.kind !== 'patch') continue
    if (message.patch.changed.sessions) sessions = message.patch.changed.sessions
    if (message.patch.changed.session && 'sessionFile' in message.patch.changed.session) {
      sessionFile = message.patch.changed.session.sessionFile
    }
  }
  return { sessions, sessionFile }
}

async function writeThread(directory: string, id: string, cwd: string, modified: string): Promise<string> {
  const path = join(directory, `${id}.jsonl`)
  await writeFile(path, header(id, cwd) + userLine(id) + assistantLine(`${id} reply`, modified))
  return path
}

describe('host session catalog publication', () => {
  it('pushes JSONL create/append/rename/delete to a read-only preview socket without a click', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-publish-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const workspacePath = join(root, 'project')
    const runtimeDir = join(root, 'runtime')
    const directory = getPiSessionDirectory(workspacePath, agentDir)
    await mkdir(directory, { recursive: true })
    const alphaPath = await writeThread(directory, 'alpha', workspacePath, '2026-01-01T00:02:00.000Z')
    const betaPath = await writeThread(directory, 'beta', workspacePath, '2026-01-01T00:03:00.000Z')
    const createSession = createRuntimeSessionFactory(runtimeDir, true, { agentDir, cachePath: false, liveBridgeDirectory: false })
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: alphaPath })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const catalog = initial.kernel.get(sessionCatalogToken) as PiSessionCatalog
    const host = createWorkspaceHost({
      controller: initial.controller,
      flows: initial.flows,
      runtime,
      workspacePath,
      port: 0,
      token: generateHostToken(),
    })
    const preview = new TestClient(wsUrl(host))
    const idle = new TestClient(wsUrl(host))
    try {
      await preview.open()
      await idle.open()
      await preview.next((message) => message.kind === 'welcome')
      await idle.next((message) => message.kind === 'welcome')
      preview.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: betaPath } })
      await preview.next((message) => message.kind === 'result' && message.id === 1)
      expect(runtime.hasExecutionLease(betaPath)).toBe(false)
      expect(catalogFrom(preview).sessionFile).toBe(betaPath)
      const beforeClick = catalogFrom(preview).sessions.map((session) => ({ id: session.id, modifiedAt: session.modifiedAt, title: session.title }))

      const statsBefore = catalog.statCount
      const appendStarted = performance.now()
      await appendFile(alphaPath, JSON.stringify({ type: 'session_info', name: 'Renamed from Pi' }) + '\n')
      await waitFor(() => catalogFrom(preview).sessions.some((session) => session.id === 'alpha' && session.title === 'Renamed from Pi'))
      const appendLatency = performance.now() - appendStarted
      expect(appendLatency).toBeLessThan(2_000)
      expect(catalog.statCount - statsBefore).toBeLessThan(8)
      expect(catalogFrom(preview).sessionFile).toBe(betaPath)
      expect(catalogFrom(idle).sessions.some((session) => session.id === 'alpha' && session.title === 'Renamed from Pi')).toBe(true)
      expect(runtime.hasExecutionLease(betaPath)).toBe(false)
      expect(runtime.defaultSessionKey === betaPath).toBe(false)

      const createdPath = join(directory, 'gamma.jsonl')
      await writeFile(createdPath, header('gamma', workspacePath, '2026-05-01T00:00:00.000Z') + userLine('gamma', '2026-05-01T00:01:00.000Z') + assistantLine('gamma reply', '2026-05-01T00:02:00.000Z'))
      await waitFor(() => catalogFrom(preview).sessions.some((session) => session.id === 'gamma'))

      const renamedPath = join(directory, 'gamma-renamed.jsonl')
      await rename(createdPath, renamedPath)
      await waitFor(() => catalogFrom(preview).sessions.some((session) => session.id === 'gamma' && session.path === renamedPath))

      await rm(renamedPath)
      await waitFor(() => catalogFrom(preview).sessions.every((session) => session.id !== 'gamma'))
      expect(catalogFrom(preview).sessionFile).toBe(betaPath)

      preview.send({ kind: 'command', id: 2, command: { type: 'reportPresence', clientId: 'desktop', surface: 'desktop', visibility: 'visible', sessionPath: betaPath } })
      await preview.next((message) => message.kind === 'result' && message.id === 2)
      preview.send({ kind: 'command', id: 3, command: { type: 'switchSession', path: alphaPath } })
      await preview.next((message) => message.kind === 'result' && message.id === 3)
      const afterBrowse = catalogFrom(preview).sessions
      for (const previous of beforeClick) {
        if (previous.id === 'alpha') continue
        const current = afterBrowse.find((session) => session.id === previous.id)
        expect(current?.modifiedAt).toBe(previous.modifiedAt)
      }
      expect(afterBrowse.find((session) => session.id === 'beta')?.modifiedAt).toBe(beforeClick.find((session) => session.id === 'beta')?.modifiedAt)
    } finally {
      await preview.close().catch(() => undefined)
      await idle.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)
})
