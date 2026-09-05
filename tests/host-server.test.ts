import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import { applyWorkbenchCommand, FrameAssembler, MAX_WS_FRAME_BYTES, utf8ByteLength, type ClientMessage, type ServerMessage } from '../src/protocol/index.ts'
import { createWorkspaceHost, hostConnectUrl, phonePairingLink, type WorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

const WORKSPACE = '/tmp/heddlework-host-server'

async function bootstrap(): Promise<{ kernel: WorkbenchKernel; controller: WorkbenchController; host: WorkspaceHost }> {
  const kernel = new WorkbenchKernel()
  kernel.mount(createWorkbenchControllerPlugin(WORKSPACE))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createAgentTransportPlugin({ cwd: WORKSPACE, demo: true, piArgs: [] }))
  const controller = kernel.get(workbenchControllerToken)
  await controller.start()
  const host = createWorkspaceHost({ controller, flows: kernel.get(flowRuntimeToken), workspacePath: WORKSPACE, port: 0, token: generateHostToken() })
  return { kernel, controller, host }
}

class TestClient {
  readonly socket: WebSocket
  readonly messages: ServerMessage[] = []
  readonly rawSizes: number[] = []
  readonly #frames = new FrameAssembler()
  readonly #waiters: Array<{ predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }> = []

  constructor(url: string) {
    this.socket = new WebSocket(url)
    this.socket.addEventListener('message', (event) => {
      const raw = String(event.data)
      this.rawSizes.push(utf8ByteLength(raw))
      const assembled = this.#frames.push(raw)
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

  closed(): Promise<number> {
    return new Promise((resolve) => this.socket.addEventListener('close', (event) => resolve(event.code)))
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message))
  }

  next(predicate: (message: ServerMessage) => boolean, timeoutMs = 5_000): Promise<ServerMessage> {
    const existing = this.messages.find(predicate)
    if (existing) return Promise.resolve(existing)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for server message')), timeoutMs)
      this.#waiters.push({ predicate, resolve: (message) => { clearTimeout(timer); resolve(message) } })
    })
  }
}

function wsUrl(host: WorkspaceHost, token = host.token): string {
  return `${host.url.replace('http', 'ws')}/ws?token=${encodeURIComponent(token)}`
}

describe('workspace host server', () => {
  it('rejects a wrong token and answers health without one', async () => {
    const { kernel, host } = await bootstrap()
    const health = await fetch(`${host.url}/health`)
    expect(health.status).toBe(200)
    expect(((await health.json()) as { protocol: number }).protocol).toBe(1)
    const denied = await fetch(`${host.url}/ws?token=wrong`, { headers: { upgrade: 'websocket', connection: 'upgrade' } })
    expect(denied.status).toBe(401)
    const bad = new TestClient(wsUrl(host, 'wrong'))
    const code = await bad.closed()
    expect(code).not.toBe(1000)
    expect(hostConnectUrl(host)).toContain(`?token=${encodeURIComponent(host.token)}`)
    await host.close()
    await kernel.dispose()
  }, 10_000)

  it('sends welcome, applies commands, and streams patches until the turn settles', async () => {
    const { kernel, controller, host } = await bootstrap()
    const client = new TestClient(wsUrl(host))
    await client.open()
    const welcome = await client.next((message) => message.kind === 'welcome')
    if (welcome.kind !== 'welcome') throw new Error('expected welcome')
    expect(welcome.protocol).toBe(1)
    expect(welcome.workspacePath).toBe(WORKSPACE)
    expect(welcome.hostUrls).toEqual([])
    expect(welcome.snapshot.connection).toBe('connected')
    expect(host.connectionCount()).toBe(1)

    client.send({ kind: 'ping' })
    await client.next((message) => message.kind === 'pong')

    client.send({ kind: 'command', id: 1, command: { type: 'setEditorText', text: 'typed remotely' } })
    const result = await client.next((message) => message.kind === 'result' && message.id === 1)
    expect(result).toEqual({ kind: 'result', id: 1, ok: true })
    const patch = await client.next((message) => message.kind === 'patch' && message.patch.changed.editorText === 'typed remotely')
    expect(patch.kind).toBe('patch')

    client.send({ kind: 'command', id: 2, command: { type: 'setModel', provider: 'nope', id: 'missing' } })
    const failed = await client.next((message) => message.kind === 'result' && message.id === 2)
    expect(failed).toEqual({ kind: 'result', id: 2, ok: false, error: 'Unknown model: nope/missing' })

    client.send({ kind: 'command', id: 3, command: { type: 'submit', text: 'Run one demo turn over the host' } })
    await client.next((message) => message.kind === 'result' && message.id === 3)
    await client.next((message) => message.kind === 'patch' && message.patch.changed.session?.isStreaming === true)
    await client.next((message) => message.kind === 'patch' && message.patch.changed.session?.isStreaming === false, 8_000)
    await client.next((message) => message.kind === 'patch' && message.patch.changed.messages?.length === 4 && message.patch.changed.messages.at(-1)?.role === 'assistant', 8_000)
    expect(controller.getSnapshot().messages.at(-1)?.role).toBe('assistant')
    const messagesPatch = [...client.messages].reverse().find((message) => message.kind === 'patch' && message.patch.changed.messages !== undefined)
    expect(messagesPatch).toBeDefined()

    client.socket.send('not json')
    const error = await client.next((message) => message.kind === 'error')
    expect(error.kind).toBe('error')

    const closed = client.closed()
    await host.close()
    expect(await closed).toBe(1001)
    expect(host.connectionCount()).toBe(0)
    await kernel.dispose()
  }, 15_000)

  it('chunks a welcome larger than the iOS default WebSocket cap and reassembles it', async () => {
    const { kernel, controller, host } = await bootstrap()
    const payload = 'x'.repeat(1_200_000)
    await applyWorkbenchCommand(controller, { type: 'setEditorText', text: payload })
    const client = new TestClient(wsUrl(host))
    await client.open()
    const welcome = await client.next((message) => message.kind === 'welcome' || message.kind === 'error', 15_000)
    if (welcome.kind !== 'welcome') throw new Error(`expected welcome, got ${JSON.stringify(welcome)}`)
    expect(welcome.snapshot.editorText).toBe(payload)
    expect(client.rawSizes.length).toBeGreaterThan(1)
    expect(Math.max(...client.rawSizes)).toBeLessThanOrEqual(MAX_WS_FRAME_BYTES)
    expect(phonePairingLink(host)).toBeUndefined()
    await host.close()
    await kernel.dispose()
  }, 20_000)
})
