import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import {
  discoverPiLiveBridges,
  ensureHeddleworkLiveBridgeInstalled,
  heddleworkLiveBridgePath,
  HEDDLEWORK_LIVE_BRIDGE_SOURCE,
  HEDDLEWORK_LIVE_STATE_WIDGET,
  PiLiveBridgeTransport,
  parsePiLiveSessionStateRecord,
  piLiveBridgeDirectory,
  resolvePiAgentDir,
  type PiLiveBridgeAdvertisement,
} from '../src/pi/live-bridge.ts'
import { createPiTransport, selectPiLiveAdvertisement } from '../src/pi/rpc-transport.ts'
import type { RpcRecord } from '../src/pi/types.ts'

const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('Pi live bridge', () => {
  test('materializes an authenticated loopback extension and advertises no remote bind', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-live-source-'))
    temporary.push(root)
    const path = heddleworkLiveBridgePath(root)
    expect(await Bun.file(path).text()).toBe(HEDDLEWORK_LIVE_BRIDGE_SOURCE)
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('server.listen(0, "127.0.0.1"')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('randomBytes(32)')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('mode: 0o600')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).not.toContain('0.0.0.0')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('const KEY = Symbol.for("heddlework.pi.live.bridge.v1")')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('const authTimer = setTimeout')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('[{ type: "text", text: request.message }, ...images]')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('for (const eventName of ["agent_start", "agent_settled", "model_select", "thinking_level_select", "session_info_changed"])')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('request.type === "get_live_state"')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('type: "heddlework_session_state"')
    expect(HEDDLEWORK_LIVE_BRIDGE_SOURCE).toContain('ctx.ui.setWidget(STATE_WIDGET')
  })

  test('parses private RPC state widget into a dedicated transport record', () => {
    expect(parsePiLiveSessionStateRecord({
      type: 'extension_ui_request', id: 'state', method: 'setWidget', widgetKey: HEDDLEWORK_LIVE_STATE_WIDGET,
      widgetLines: [JSON.stringify({ type: 'heddlework_session_state', state: { sessionId: 's' }, cwd: '/tmp/project' })],
    })).toEqual({ type: 'heddlework_session_state', state: { sessionId: 's' }, cwd: '/tmp/project' })
  })

  test('process guard dedupes duplicate loads and token events do not rewrite registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-live-runtime-'))
    temporary.push(root)
    const runtimeDir = join(root, 'runtime')
    const extension = heddleworkLiveBridgePath(join(root, 'extension'))
    const previousRuntime = process.env.HEDDLEWORK_RUNTIME_DIR
    process.env.HEDDLEWORK_RUNTIME_DIR = runtimeDir
    try {
      const factory = (await import(`${extension}?test=${Date.now()}`)).default as (pi: any) => void
      const handlers = new Map<string, Function>()
      const duplicateHandlers = new Map<string, Function>()
      const makePi = (target: Map<string, Function>) => ({
        on(name: string, handler: Function) { target.set(name, handler) },
        getThinkingLevel: () => 'medium',
        getSessionName: () => undefined,
        getCommands: () => [],
        sendUserMessage() {}, setThinkingLevel() {}, setSessionName() {}, async setModel() { return true },
      })
      const pi = makePi(handlers)
      factory(pi)
      factory(makePi(duplicateHandlers))
      expect(duplicateHandlers.size).toBe(0)

      let idle = true
      const ctx = {
        mode: 'tui', cwd: '/tmp/project', model: { provider: 'test', id: 'model', reasoning: false },
        isIdle: () => idle, hasPendingMessages: () => false, abort() {}, getContextUsage: () => undefined,
        ui: { setWidget() {} },
        modelRegistry: { getAvailable: () => [], find: () => undefined },
        sessionManager: {
          getSessionFile: () => '/tmp/session.jsonl', getSessionId: () => 'session', getLeafId: () => null,
          getTree: () => [], getEntries: () => [], buildContextEntries: () => [
            { type: 'message', message: { role: 'user', content: 'old' } },
            { type: 'message', message: { role: 'assistant', content: 'older' } },
            { type: 'message', message: { role: 'user', content: 'latest' } },
          ],
        },
      }
      handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx)
      const registry = join(runtimeDir, 'pi-live')
      const adPath = join(registry, `${process.pid}.json`)
      for (let attempt = 0; attempt < 100 && !existsSync(adPath); attempt++) {
        await Bun.sleep(5)
      }
      expect(existsSync(adPath)).toBe(true)
      const before = readFileSync(adPath, 'utf8')
      const update = handlers.get('message_update')
      for (let index = 0; index < 100; index++) update?.({ type: 'message_update', message: { role: 'assistant', content: `token ${index}` } }, ctx)
      expect(readFileSync(adPath, 'utf8')).toBe(before)
      handlers.get('message_start')?.({ type: 'message_start', message: { role: 'assistant', content: [{ type: 'text', text: 'prefix' }] } }, ctx)
      handlers.get('tool_execution_start')?.({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'read', args: { path: 'x' } }, ctx)
      handlers.get('tool_execution_update')?.({ type: 'tool_execution_update', toolCallId: 'tool-1', partialResult: 'partial' }, ctx)
      const advertisement = discoverPiLiveBridges(registry)[0]
      if (!advertisement) throw new Error('Expected live advertisement')
      const attached = new PiLiveBridgeTransport({ advertisement, includeMessages: true, messageLimit: 2 })
      const snapshots: RpcRecord[] = []
      attached.onEvent((event) => snapshots.push(event))
      await attached.start()
      expect(snapshots[0]).toMatchObject({
        type: 'heddlework_live_snapshot',
        messages: [{ role: 'assistant', content: 'older' }, { role: 'user', content: 'latest' }],
        assistant: { role: 'assistant', content: [{ type: 'text', text: 'prefix' }] },
        tools: [{ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'read', args: { path: 'x' }, partialResult: 'partial' }],
      })
      idle = false
      handlers.get('agent_start')?.({ type: 'agent_start' }, ctx)
      expect(JSON.parse(readFileSync(adPath, 'utf8')).isStreaming).toBe(true)
      handlers.get('agent_settled')?.({ type: 'agent_settled' }, ctx)
      const settled = await attached.request<{ assistant?: unknown; tools: unknown[]; sequence: number }>({ type: 'get_live_state' })
      expect(settled.assistant).toBeUndefined()
      expect(settled.tools).toEqual([])
      expect(snapshots.filter((event) => typeof event.sequence === 'number').every((event, index, sequenced) => index === 0 || Number(event.sequence) > Number(sequenced[index - 1]!.sequence))).toBe(true)
      await attached.stop()
      handlers.get('session_shutdown')?.({ type: 'session_shutdown', reason: 'quit' }, ctx)
    } finally {
      if (previousRuntime === undefined) delete process.env.HEDDLEWORK_RUNTIME_DIR
      else process.env.HEDDLEWORK_RUNTIME_DIR = previousRuntime
    }
  })

  test('installs into Pi user extensions for ordinary TUI launches', async () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'heddlework-live-agent-'))
    temporary.push(agentDir)
    const path = ensureHeddleworkLiveBridgeInstalled(agentDir)
    expect(path).toBe(join(agentDir, 'extensions', 'heddlework-live-bridge.js'))
    expect(await Bun.file(path).text()).toBe(HEDDLEWORK_LIVE_BRIDGE_SOURCE)
  })

  test('discovers live advertisements and removes stale process entries', () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-live-registry-'))
    temporary.push(root)
    const live: PiLiveBridgeAdvertisement = {
      version: 1,
      pid: process.pid,
      port: 1234,
      token: 'secret',
      mode: 'tui',
      cwd: '/tmp/project',
      sessionId: 'session-live',
      updatedAt: Date.now(),
    }
    writeFileSync(join(root, 'live.json'), JSON.stringify(live))
    const ancient = new Date(0)
    utimesSync(join(root, 'live.json'), ancient, ancient)
    writeFileSync(join(root, 'dead.json'), JSON.stringify({ ...live, pid: 999_999_999, sessionId: 'dead' }))
    expect(discoverPiLiveBridges(root)).toEqual([live])
    expect(discoverPiLiveBridges(root).some((bridge) => bridge.sessionId === 'dead')).toBe(false)
  })

  test('uses stable private registry and Pi agent-dir override', () => {
    expect(piLiveBridgeDirectory({ HEDDLEWORK_RUNTIME_DIR: '/runtime' }, '/home/me', 'linux')).toBe(join('/runtime', 'pi-live'))
    expect(resolvePiAgentDir({ PI_CODING_AGENT_DIR: '~/custom-pi' }, '/home/me')).toBe(join('/home/me', 'custom-pi'))
  })

  test('selector requires explicit session identity and defers ownership until start', () => {
    const advertisement: PiLiveBridgeAdvertisement = {
      version: 1, pid: process.pid, port: 1234, token: 'secret', mode: 'tui', cwd: '/tmp/project', sessionId: 'live', sessionFile: '/tmp/live.jsonl', updatedAt: Date.now(),
    }
    expect(selectPiLiveAdvertisement({}, [advertisement])).toBeUndefined()
    expect(selectPiLiveAdvertisement({ sessionFile: '/tmp/live.jsonl' }, [advertisement])).toBe(advertisement)
    expect(selectPiLiveAdvertisement({ sessionId: 'live' }, [advertisement])).toBe(advertisement)
    const attached = createPiTransport({ cwd: '/tmp/project', sessionFile: '/tmp/live.jsonl', liveAdvertisements: [advertisement] })
    expect(attached.ownership).toBeUndefined()
    const owned = createPiTransport({ cwd: '/tmp/other', liveAdvertisements: [advertisement] })
    expect(owned.ownership).toBeUndefined()
  })

  test('selector stays attached after owner failure and never falls through to a spawned writer', async () => {
    const advertisement: PiLiveBridgeAdvertisement = {
      version: 1, pid: process.pid, port: 1, token: 'secret', mode: 'tui', cwd: '/tmp/project', sessionId: 'live', sessionFile: '/tmp/live.jsonl', updatedAt: Date.now(),
    }
    const transport = createPiTransport({ cwd: '/tmp/project', sessionFile: '/tmp/live.jsonl', liveAdvertisements: [advertisement] })
    await expect(transport.start()).rejects.toThrow()
    expect(transport.ownership).toBe('attached')
    await expect(transport.start()).rejects.toThrow()
    expect(transport.ownership).toBe('attached')
  })

  test('authenticates, correlates commands, and forwards live events', async () => {
    const token = 'token-for-test'
    const server = createServer((socket) => {
      let authenticated = false
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        while (true) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) return
          const record = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
          buffer = buffer.slice(newline + 1)
          if (!authenticated) {
            expect(record).toEqual({ type: 'hello', token, version: 1 })
            authenticated = true
            continue
          }
          if (record.type === 'get_live_state') {
            socket.write(`${JSON.stringify({ type: 'response', id: record.id, command: 'get_live_state', success: true, data: { state: { sessionId: 'live' }, cwd: '/tmp', tools: [], sequence: 0 } })}\n`)
            socket.write(`${JSON.stringify({ type: 'message_start', message: { role: 'user', content: 'from tui' }, sequence: 1 })}\n`)
          } else if (record.type === 'prompt') {
            socket.write(`${JSON.stringify({ type: 'response', id: record.id, command: 'prompt', success: true })}\n`)
          }
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const transport = new PiLiveBridgeTransport({ advertisement: {
      version: 1, pid: process.pid, port: address.port, token, mode: 'tui', cwd: '/tmp', sessionId: 'live', updatedAt: Date.now(),
    } })
    const events: string[] = []
    transport.onEvent((event) => events.push(event.type))
    await transport.start()
    await transport.request({ type: 'prompt', message: 'hello' })
    await Bun.sleep(10)
    expect(events).toContain('message_start')
    await transport.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('publishes an atomic live snapshot before replaying only newer buffered events', async () => {
    const token = 'snapshot-token'
    const requests: Record<string, unknown>[] = []
    const server = createServer((socket) => {
      let authenticated = false
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        while (true) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) return
          const record = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
          buffer = buffer.slice(newline + 1)
          if (!authenticated) { authenticated = true; continue }
          requests.push(record)
          if (record.type === 'get_live_state') {
            socket.write(`${JSON.stringify({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, sequence: 11 })}\n`)
            socket.write(`${JSON.stringify({ type: 'response', id: record.id, command: 'get_live_state', success: true, data: {
              state: { sessionId: 'live', sessionFile: '/tmp/live.jsonl', isStreaming: true }, cwd: '/tmp',
              messages: [{ role: 'user', content: 'question' }], assistant: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] },
              tools: [{ type: 'tool_execution_update', toolCallId: 't', toolName: 'read', args: { path: 'x' }, partialResult: 'a' }], sequence: 10,
            } })}\n`)
            socket.write(`${JSON.stringify({ type: 'message_update', message: { role: 'assistant', content: [{ type: 'text', text: 'hello!' }] }, sequence: 12 })}\n`)
          }
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const transport = new PiLiveBridgeTransport({
      advertisement: { version: 1, pid: process.pid, port: address.port, token, mode: 'tui', cwd: '/tmp', sessionId: 'live', sessionFile: '/tmp/live.jsonl', updatedAt: Date.now() },
      includeMessages: true,
      messageLimit: 40,
    })
    const events: RpcRecord[] = []
    transport.onEvent((event) => events.push(event))
    await transport.start()
    await Bun.sleep(10)
    expect(requests[0]).toMatchObject({ type: 'get_live_state', includeMessages: true, messageLimit: 40 })
    expect(events.map((event) => [event.type, event.sequence])).toEqual([
      ['heddlework_live_snapshot', 10],
      ['message_update', 11],
      ['message_update', 12],
    ])
    expect(events[0]).toMatchObject({
      assistant: { role: 'assistant', content: [{ type: 'text', text: 'hel' }] },
      tools: [{ toolCallId: 't', toolName: 'read', args: { path: 'x' }, partialResult: 'a' }],
      messages: [{ role: 'user', content: 'question' }],
    })
    await transport.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('rejects attach when the owner changed session before snapshot', async () => {
    const token = 'changed-token'
    const server = createServer((socket) => {
      let lines = ''
      let hello = true
      socket.on('data', (chunk) => {
        lines += chunk.toString()
        while (lines.includes('\n')) {
          const newline = lines.indexOf('\n')
          const record = JSON.parse(lines.slice(0, newline)) as Record<string, unknown>
          lines = lines.slice(newline + 1)
          if (hello) { hello = false; continue }
          if (record.type === 'get_live_state') socket.write(`${JSON.stringify({ type: 'response', id: record.id, command: 'get_live_state', success: true, data: { state: { sessionId: 'other', sessionFile: '/tmp/other.jsonl' }, cwd: '/tmp', tools: [], sequence: 0 } })}\n`)
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const transport = new PiLiveBridgeTransport({ advertisement: { version: 1, pid: process.pid, port: address.port, token, mode: 'tui', cwd: '/tmp', sessionId: 'live', sessionFile: '/tmp/live.jsonl', updatedAt: Date.now() } })
    await expect(transport.start()).rejects.toThrow('owner changed session')
    await transport.stop()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('stop during startup rejects promptly instead of waiting for connect/request timeout', async () => {
    const token = 'stop-token'
    const sockets = new Set<import('node:net').Socket>()
    const server = createServer((socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const transport = new PiLiveBridgeTransport({
      advertisement: { version: 1, pid: process.pid, port: address.port, token, mode: 'tui', cwd: '/tmp', sessionId: 'live', updatedAt: Date.now() },
      requestTimeoutMs: 10_000,
    })
    const starting = transport.start()
    await Bun.sleep(5)
    await transport.stop()
    await expect(Promise.race([starting.then(() => 'resolved', () => 'rejected'), Bun.sleep(250).then(() => 'timeout')])).resolves.toBe('rejected')
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  test('authentication failure closes the socket and rejects startup', async () => {
    let closed = false
    const server = createServer((socket) => {
      socket.once('data', () => socket.destroy())
      socket.once('close', () => { closed = true })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const transport = new PiLiveBridgeTransport({ advertisement: { version: 1, pid: process.pid, port: address.port, token: 'bad', mode: 'tui', cwd: '/tmp', sessionId: 'live', updatedAt: Date.now() } })
    await expect(transport.start()).rejects.toThrow()
    for (let attempt = 0; attempt < 20 && !closed; attempt++) await Bun.sleep(5)
    expect(closed).toBe(true)
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  const realPi = process.env.HEDDLEWORK_TEST_PI
  test.skipIf(!realPi)('real Pi bridge auto-loads from the user extension directory and supports controller refresh commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-live-real-'))
    const agentDir = join(root, 'agent')
    const runtimeDir = join(root, 'runtime')
    temporary.push(root)
    ensureHeddleworkLiveBridgeInstalled(agentDir)
    const commandExtension = join(root, 'command.mjs')
    writeFileSync(commandExtension, `export default function(pi){pi.registerCommand("bridge-test",{description:"test",handler:async(args)=>{pi.setSessionName("slash:"+args)}})}`)
    // The bridge is intentionally NOT passed via --extension here: this proves
    // ordinary Pi user-extension auto-discovery sees the installed .js file.
    const child = spawn(realPi!, ['--mode', 'rpc', '--no-session', '--offline', '--extension', commandExtension], {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, HEDDLEWORK_RUNTIME_DIR: runtimeDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stderr = ''
    let stdout = ''
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    try {
      let advertisement: PiLiveBridgeAdvertisement | undefined
      for (let attempt = 0; attempt < 250 && !advertisement; attempt++) {
        advertisement = discoverPiLiveBridges(join(runtimeDir, 'pi-live')).find((candidate) => candidate.pid === child.pid)
        if (!advertisement) await Bun.sleep(20)
      }
      if (!advertisement) throw new Error(`Pi bridge did not advertise: ${stderr}`)
      const transport = new PiLiveBridgeTransport({ advertisement })
      await transport.start()
      for (const type of ['get_messages', 'get_tree', 'get_fork_messages', 'get_available_thinking_levels', 'get_session_stats', 'get_live_state']) {
        await expect(transport.request({ type })).resolves.toBeDefined()
      }
      await transport.request({ type: 'prompt', message: '/bridge-test hello' })
      for (let attempt = 0; attempt < 50; attempt++) {
        const state = await transport.request<{ sessionName?: string }>({ type: 'get_state' })
        if (state.sessionName === 'slash:hello') break
        await Bun.sleep(10)
      }
      expect((await transport.request<{ sessionName?: string }>({ type: 'get_state' })).sessionName).toBe('slash:hello')
      expect(stdout).toContain('"widgetKey":"heddlework.live.state.v1"')
      expect(stdout).toContain('\\"sessionName\\":\\"slash:hello\\"')
      await transport.stop()
    } finally {
      child.kill('SIGTERM')
      await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), Bun.sleep(2_000)])
      if (child.exitCode === null) child.kill('SIGKILL')
    }
  }, 15_000)
})
