import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createRuntimeSessionFactory } from '../src/host/runtime-composition.ts'
import { SessionRuntime } from '../src/host/session-runtime.ts'
import { createWorkspaceHost, type WorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { FrameAssembler, type ClientMessage, type ServerMessage } from '../src/protocol/index.ts'
import { writeLongSessionFiles } from './helpers/long-session-host.ts'

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
      const message = JSON.parse(assembled) as ServerMessage
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

  editorText(): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index]!
      if (message.kind === 'welcome') return message.snapshot.editorText
      if (message.kind === 'patch' && message.patch.changed.editorText !== undefined) return message.patch.changed.editorText
    }
    return undefined
  }
}

function wsUrl(host: WorkspaceHost): string {
  return `${host.url.replace('http', 'ws')}/ws?token=${encodeURIComponent(host.token)}`
}

describe('session runtime routing', () => {
  it('replays admitted command completion for duplicate request ids', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-admission-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-admission-rt-'))
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default' })
    const runtime = new SessionRuntime({
      initial,
      createSession,
      path: join(runtimeDir, 'registry.json'),
      journalPath: join(runtimeDir, 'journal.json'),
    })
    await runtime.startInitial()
    const clientId = 'client-a'
    const requestId = 'req-1'
    const command = { type: 'submit', text: 'hello' } as const
    const sessionKey = runtime.defaultSessionKey
    expect(runtime.admission(clientId, requestId, command, sessionKey)).toEqual({ action: 'execute' })
    runtime.recordCommandResult(clientId, requestId, command, sessionKey, true)
    const replay = runtime.admission(clientId, requestId, command, sessionKey)
    expect(replay.action).toBe('respond')
    if (replay.action === 'respond') expect(replay.record.ok).toBe(true)
    await runtime.dispose()
  })

  it('keeps websocket snapshots isolated per attached session', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-route-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-route-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({
      controller: initial.controller,
      flows: initial.flows,
      runtime,
      workspacePath,
      port: 0,
      token: generateHostToken(),
    })
    const alphaClient = new TestClient(wsUrl(host))
    const betaClient = new TestClient(wsUrl(host))
    try {
      await alphaClient.open()
      await betaClient.open()
      await alphaClient.next((message) => message.kind === 'welcome')
      await betaClient.next((message) => message.kind === 'welcome')

      alphaClient.send({ kind: 'command', id: 1, command: { type: 'setEditorText', text: 'alpha-only' } })
      await alphaClient.next((message) => message.kind === 'result' && message.id === 1)
      await alphaClient.next((message) => message.kind === 'patch' && message.patch.changed.editorText === 'alpha-only')

      betaClient.send({ kind: 'command', id: 2, command: { type: 'switchSession', path: files.beta.path } })
      await betaClient.next((message) => message.kind === 'result' && message.id === 2)

      betaClient.send({ kind: 'command', id: 3, command: { type: 'setEditorText', text: 'beta-only' } })
      await betaClient.next((message) => message.kind === 'result' && message.id === 3)
      await betaClient.next((message) => message.kind === 'patch' && message.patch.changed.editorText === 'beta-only')

      expect(alphaClient.editorText()).toBe('alpha-only')
      expect(betaClient.editorText()).toBe('beta-only')
      expect(alphaClient.messages.some((message) => message.kind === 'patch' && message.patch.changed.editorText === 'beta-only')).toBe(false)
    } finally {
      await alphaClient.close().catch(() => undefined)
      await betaClient.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)
})

