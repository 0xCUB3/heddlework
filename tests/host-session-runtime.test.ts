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

  it('shows the clicked thread before its bundle is ready', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-preview-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-preview-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({ controller: initial.controller, flows: initial.flows, runtime, workspacePath, port: 0, token: generateHostToken() })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: files.beta.path } })
      const preview = await client.next((message) => message.kind === 'patch' && message.patch.changed.session?.sessionFile === files.beta.path)
      const result = await client.next((message) => message.kind === 'result' && message.id === 1)
      // The preview patch arrives before the command completes, so the UI never waits on Pi startup.
      expect(client.messages.indexOf(preview)).toBeLessThan(client.messages.indexOf(result))
      expect(preview.kind === 'patch' && preview.patch.changed.connection).toBe('connecting')
      const transcript = await client.next((message) => message.kind === 'patch' && Array.isArray(message.patch.changed.messages) && message.patch.changed.messages.length > 0)
      expect(transcript.kind).toBe('patch')
      expect(runtime.hasExecutionLease(files.beta.path)).toBe(false)
      expect(runtime.executionLeaseCount()).toBe(1)
    } finally {
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('paints an empty draft the moment New thread is clicked, before its bundle boots', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-new-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-new-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({ controller: initial.controller, flows: initial.flows, runtime, workspacePath, port: 0, token: generateHostToken() })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'newSession' } })
      const preview = await client.next((message) => message.kind === 'patch' && message.patch.changed.connection === 'connecting')
      const result = await client.next((message) => message.kind === 'result' && message.id === 1)
      expect(client.messages.indexOf(preview)).toBeLessThan(client.messages.indexOf(result))
      expect(preview.kind === 'patch' && preview.patch.changed.messages).toEqual([])
      expect(preview.kind === 'patch' && preview.patch.changed.session?.sessionFile).toBeUndefined()
      const connected = await client.next((message) => message.kind === 'patch' && message.patch.changed.connection === 'connected')
      expect(connected.kind === 'patch' && connected.patch.changed.session?.sessionFile).not.toBe(files.alpha.path)
    } finally {
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('does not route browse edits to the old thread, and submit starts the selected lease', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-pending-route-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-pending-route-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const baseFactory = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await baseFactory({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    let beta: Awaited<ReturnType<typeof baseFactory>> | undefined
    const createSession: ReturnType<typeof createRuntimeSessionFactory> = async (input) => {
      const created = await baseFactory(input)
      if (input.sessionPath === files.beta.path) beta = created
      return created
    }
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({ controller: initial.controller, flows: initial.flows, runtime, workspacePath, port: 0, token: generateHostToken() })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: files.beta.path } })
      await client.next((message) => message.kind === 'result' && message.id === 1)
      expect(runtime.hasExecutionLease(files.beta.path)).toBe(false)
      client.send({ kind: 'command', id: 2, command: { type: 'setEditorText', text: 'beta-during-open' } })
      await client.next((message) => message.kind === 'result' && message.id === 2)
      expect(initial.controller.getSnapshot().editorText).not.toBe('beta-during-open')
      expect(runtime.hasExecutionLease(files.beta.path)).toBe(false)
      client.send({ kind: 'command', id: 3, command: { type: 'submit', text: 'act on beta' } })
      await client.next((message) => message.kind === 'result' && message.id === 3)
      expect(runtime.hasExecutionLease(files.beta.path)).toBe(true)
      expect(beta).toBeDefined()
      expect(initial.controller.getSnapshot().editorText).not.toBe('beta-during-open')
    } finally {
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('keeps the latest thread selected when rapid switches complete out of order', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-latest-route-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-latest-route-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({ controller: initial.controller, flows: initial.flows, runtime, workspacePath, port: 0, token: generateHostToken() })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: files.beta.path } })
      await client.next((message) => message.kind === 'result' && message.id === 1)
      client.send({ kind: 'command', id: 2, command: { type: 'switchSession', path: files.alpha.path } })
      await client.next((message) => message.kind === 'result' && message.id === 2)
      expect(runtime.executionLeaseCount()).toBe(1)
      expect(runtime.hasExecutionLease(files.beta.path)).toBe(false)
      client.send({ kind: 'command', id: 3, command: { type: 'submit', text: 'latest-alpha' } })
      const setResult = await client.next((message) => message.kind === 'result' && message.id === 3)
      expect(setResult).toMatchObject({ kind: 'result', ok: true })
      expect(runtime.hasExecutionLease(files.alpha.path)).toBe(true)
      expect(runtime.hasExecutionLease(files.beta.path)).toBe(false)
    } finally {
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('does not let a late disk preview overwrite a connected live bundle', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-late-preview-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-late-preview-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    let releaseHistory!: () => void
    const historyGate = new Promise<void>((resolve) => { releaseHistory = resolve })
    const host = createWorkspaceHost({
      controller: initial.controller,
      flows: initial.flows,
      runtime,
      workspacePath,
      port: 0,
      token: generateHostToken(),
      loadSessionHistory: async () => { await historyGate; return { messages: [], hasOlder: false } },
    })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: files.beta.path } })
      await client.next((message) => message.kind === 'result' && message.id === 1)
      client.send({ kind: 'command', id: 2, command: { type: 'submit', text: 'start beta' } })
      const connected = await client.next((message) => message.kind === 'patch' && message.patch.changed.connection === 'connected')
      const connectedIndex = client.messages.indexOf(connected)
      releaseHistory()
      await Bun.sleep(20)
      expect(client.messages.slice(connectedIndex + 1).some((message) => message.kind === 'patch' && message.patch.changed.connection === 'connecting')).toBe(false)
    } finally {
      releaseHistory()
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('rejects a command whose intended navigation is superseded', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-superseded-command-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-superseded-command-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const baseFactory = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await baseFactory({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let beta: Awaited<ReturnType<typeof baseFactory>> | undefined
    const createSession: ReturnType<typeof createRuntimeSessionFactory> = async (input) => {
      const created = await baseFactory(input)
      if (input.sessionPath === files.beta.path) { beta = created; await gate }
      return created
    }
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({ controller: initial.controller, flows: initial.flows, runtime, workspacePath, port: 0, token: generateHostToken() })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: files.beta.path } })
      await client.next((message) => message.kind === 'patch' && message.patch.changed.session?.sessionFile === files.beta.path)
      client.send({ kind: 'command', id: 2, command: { type: 'submit', text: 'must-not-land' } })
      client.send({ kind: 'command', id: 3, command: { type: 'switchSession', path: files.alpha.path } })
      await client.next((message) => message.kind === 'result' && message.id === 3)
      release()
      const rejected = await client.next((message) => message.kind === 'result' && message.id === 2)
      expect(rejected).toMatchObject({ kind: 'result', ok: false })
      expect(initial.controller.getSnapshot().editorText).not.toBe('must-not-land')
      expect(beta?.controller.getSnapshot().editorText).not.toBe('must-not-land')
    } finally {
      release()
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('rejects commands queued behind a failed navigation instead of rolling them back to the old thread', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-failed-command-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-failed-command-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const baseFactory = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await baseFactory({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const createSession: ReturnType<typeof createRuntimeSessionFactory> = async (input) => {
      if (input.sessionPath === files.beta.path) throw new Error('open failed')
      return baseFactory(input)
    }
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({ controller: initial.controller, flows: initial.flows, runtime, workspacePath, port: 0, token: generateHostToken() })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: files.beta.path } })
      await client.next((message) => message.kind === 'result' && message.id === 1)
      client.send({ kind: 'command', id: 2, command: { type: 'submit', text: 'must-not-rollback' } })
      const rejected = await client.next((message) => message.kind === 'result' && message.id === 2 && !message.ok)
      expect(rejected).toMatchObject({ kind: 'result', ok: false })
      expect(initial.controller.getSnapshot().editorText).not.toBe('must-not-rollback')
      expect(runtime.hasExecutionLease(files.beta.path)).toBe(false)
    } finally {
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('drops a stale preview history page when loadEarlier is superseded by a session switch', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-stale-earlier-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-stale-earlier-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    let calls = 0
    let releaseEarlier!: () => void
    const earlierGate = new Promise<void>((resolve) => { releaseEarlier = resolve })
    let markEarlierStarted!: (sessionPath: string) => void
    const earlierStarted = new Promise<string>((resolve) => { markEarlierStarted = resolve })
    const host = createWorkspaceHost({
      controller: initial.controller,
      flows: initial.flows,
      runtime,
      workspacePath,
      port: 0,
      token: generateHostToken(),
      loadSessionHistory: async (sessionPath) => {
        calls += 1
        if (calls === 1) return { messages: [{ role: 'user', content: 'beta preview', timestamp: 1, workbenchEntryId: 'beta-preview' }], hasOlder: true }
        if (sessionPath === files.beta.path) {
          markEarlierStarted(sessionPath)
          await earlierGate
          return { messages: [{ role: 'user', content: 'STALE_BETA_EARLIER', timestamp: 0, workbenchEntryId: 'beta-stale' }], hasOlder: false }
        }
        return { messages: [{ role: 'user', content: 'alpha preview', timestamp: 1, workbenchEntryId: 'alpha-preview' }], hasOlder: false }
      },
    })
    const client = new TestClient(wsUrl(host))
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      client.send({ kind: 'command', id: 1, command: { type: 'switchSession', path: files.beta.path } })
      await client.next((message) => message.kind === 'result' && message.id === 1)
      await client.next((message) => message.kind === 'patch' && Array.isArray(message.patch.changed.messages) && message.patch.changed.messages.some((entry) => String(entry.content).includes('beta preview')))

      client.send({ kind: 'command', id: 2, command: { type: 'loadEarlierMessages' } })
      expect(await earlierStarted).toBe(files.beta.path)
      client.send({ kind: 'command', id: 4, command: { type: 'loadEarlierMessages' } })
      client.send({ kind: 'command', id: 3, command: { type: 'switchSession', path: files.alpha.path } })
      await client.next((message) => message.kind === 'result' && message.id === 3)
      const afterSwitch = client.messages.length
      releaseEarlier()
      await client.next((message) => message.kind === 'result' && message.id === 2)
      await client.next((message) => message.kind === 'result' && message.id === 4)
      await Bun.sleep(20)
      const stale = client.messages.slice(afterSwitch).some((message) => message.kind === 'patch'
        && (message.patch.changed.messages ?? message.patch.messagesPrepend ?? []).some((entry) => String(entry.content).includes('STALE_BETA_EARLIER')))
      expect(stale).toBe(false)
      expect(calls).toBe(3)
    } finally {
      releaseEarlier()
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)

  it('shares thread lifecycle across session bundles', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-lifecycle-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-lifecycle-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    try {
      const beta = await runtime.ensureSession(files.beta.path)
      // Settle alpha from the beta bundle, then switch back to alpha's bundle: it must already know.
      beta.controller.settleThread(files.alpha.path)
      expect(initial.controller.getSnapshot().threadLifecycle[files.alpha.path]?.settledAt).toBeDefined()
      initial.controller.wakeThread(files.alpha.path)
      expect(beta.controller.getSnapshot().threadLifecycle[files.alpha.path]?.settledAt).toBeUndefined()
      expect(beta.controller.getSnapshot().threadLifecycle[files.alpha.path]?.unsettledAt).toBeDefined()
    } finally {
      await runtime.dispose()
    }
  }, 20_000)

  it('keeps an attached socket with its live owner after an external session-file change', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'heddlework-session-external-reindex-'))
    const runtimeDir = mkdtempSync(join(tmpdir(), 'heddlework-session-external-reindex-rt-'))
    const files = writeLongSessionFiles(workspacePath)
    const createSession = createRuntimeSessionFactory(runtimeDir, true)
    const initial = await createSession({ workspacePath, id: 'default', sessionPath: files.alpha.path })
    const runtime = new SessionRuntime({ initial, createSession, path: join(runtimeDir, 'registry.json') })
    await runtime.startInitial()
    const host = createWorkspaceHost({ controller: initial.controller, flows: initial.flows, runtime, workspacePath, port: 0, token: generateHostToken() })
    const client = new TestClient(wsUrl(host))
    const originalGetSnapshot = initial.controller.getSnapshot
    try {
      await client.open()
      await client.next((message) => message.kind === 'welcome')
      ;(initial.controller as unknown as { getSnapshot: typeof initial.controller.getSnapshot }).getSnapshot = () => {
        const state = originalGetSnapshot()
        return { ...state, session: { ...state.session, sessionFile: files.beta.path } }
      }
      initial.controller.setEditorText('external-switch')
      await client.next((message) => message.kind === 'patch' && message.patch.changed.session?.sessionFile === files.beta.path)

      const replacement = await runtime.ensureSession(files.alpha.path)
      client.send({ kind: 'command', id: 77, command: { type: 'setEditorText', text: 'owner-only' } })
      await client.next((message) => message.kind === 'result' && message.id === 77)

      expect(originalGetSnapshot().editorText).toBe('owner-only')
      expect(replacement.controller.getSnapshot().editorText).not.toBe('owner-only')
      expect(runtime.bundleForKey(files.alpha.path)).toBe(replacement)
      expect(runtime.bundleForKey(files.beta.path)).toBe(initial)
    } finally {
      ;(initial.controller as unknown as { getSnapshot: typeof initial.controller.getSnapshot }).getSnapshot = originalGetSnapshot
      await client.close().catch(() => undefined)
      await host.close()
      await runtime.dispose()
    }
  }, 20_000)
})
