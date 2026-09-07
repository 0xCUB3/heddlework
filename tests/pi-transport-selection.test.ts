import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Socket } from 'node:net'
import { attachJsonlReader, serializeJsonLine } from '../src/pi/jsonl.ts'
import { createPiTransport, selectPiLiveAdvertisement } from '../src/pi/rpc-transport.ts'
import type { PiLiveBridgeAdvertisement } from '../src/pi/live-bridge.ts'
import type { RpcRecord } from '../src/pi/types.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function advertisement(sessionFile: string, port = 1): PiLiveBridgeAdvertisement {
  return { version: 1, pid: process.pid, port, token: 'local-test-token', mode: 'tui', cwd: tmpdir(), sessionId: 'one', sessionFile, updatedAt: Date.now() }
}

describe('Pi transport ownership selection', () => {
  it('matches normalized explicit paths and rejects duplicate owners rather than choosing arbitrarily', () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-owner-selection-'))
    roots.push(root)
    const ad = advertisement(join(root, 'one.jsonl'))
    expect(selectPiLiveAdvertisement({ cwd: root, piArgs: ['--session', './one.jsonl'] }, [ad])).toBe(ad)
    expect(selectPiLiveAdvertisement({ cwd: root }, [ad])).toBeUndefined()
    expect(() => selectPiLiveAdvertisement({ sessionFile: ad.sessionFile }, [ad, { ...ad, pid: ad.pid + 1 }])).toThrow('Multiple Pi processes')
  })

  it('resumes the last reported owned session instead of silently creating a new one on reconnect', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-owner-resume-'))
    roots.push(root)
    const sessionFile = join(root, 'owned.jsonl')
    const fixture = join(root, 'fake-owner.ts')
    writeFileSync(fixture, `import { createInterface } from 'node:readline';
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
 const request = JSON.parse(line);
 const data = request.type === 'get_state' ? { sessionId:'owned', sessionFile:${JSON.stringify(sessionFile)}, isStreaming:false } : {argv: process.argv.slice(2)};
 console.log(JSON.stringify({type:'response',id:request.id,command:request.type,success:true,data}));
}`)
    const transport = createPiTransport({ cwd: root, command: process.execPath, commandArgs: [fixture], fabricBridge: false, liveAdvertisements: [] })
    try {
      await Promise.all([transport.start(), transport.start()])
      expect(transport.ownership).toBe('owned')
      await transport.request({ type: 'get_state' })
      await transport.stop()
      await transport.start()
      const { argv } = await transport.request<{ argv: string[] }>({ type: 'argv' })
      expect(argv[argv.indexOf('--session') + 1]).toBe(sessionFile)
    } finally { await transport.stop() }
  })

  it('tracks external session changes on reconnect and unsubscribes pre-start listeners', async () => {
    const root = mkdtempSync(join(tmpdir(), 'pi-owner-follow-'))
    roots.push(root)
    let file = join(root, 'one.jsonl')
    let id = 'one'
    let sequence = 0
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      attachJsonlReader(socket, (line) => {
        const command = JSON.parse(line) as RpcRecord
        if (command.type === 'hello') return
        const state = { sessionFile: file, sessionId: id, isStreaming: false }
        const data = command.type === 'get_live_state' ? { state, cwd: root, sequence, tools: [] } : state
        socket.write(serializeJsonLine({ type: 'response', id: command.id, command: command.type, success: true, data }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const ads = [advertisement(file, address.port)]
    const transport = createPiTransport({ cwd: root, sessionFile: file, liveAdvertisements: ads })
    let deletedCalls = 0
    const remove = transport.onEvent(() => { deletedCalls++ })
    let eventCount = 0
    transport.onEvent(() => { eventCount++ })
    try {
      await transport.start()
      remove()
      const deletedBefore = deletedCalls
      file = join(root, 'two.jsonl')
      id = 'two'
      ads[0] = { ...ads[0]!, sessionFile: file, sessionId: id }
      for (const socket of sockets) socket.write(serializeJsonLine({ type: 'heddlework_session_state', cwd: root, state: { sessionFile: file, sessionId: id, isStreaming: false }, sequence: ++sequence }))
      const deadline = Date.now() + 1_000
      while (eventCount < 2 && Date.now() < deadline) await Bun.sleep(5)
      expect(eventCount).toBe(2)
      expect(deletedCalls).toBe(deletedBefore)
      await transport.stop()
      await transport.start()
      expect((await transport.request<{ sessionId: string }>({ type: 'get_state' })).sessionId).toBe('two')
      await transport.stop()
      ads.length = 0
      await expect(transport.start()).rejects.toThrow('refusing to spawn a second writer')
    } finally {
      await transport.stop()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
