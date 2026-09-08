import { afterEach, describe, expect, it } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attachOrStartRuntime, RuntimeUpgradeDeferredError, stageRuntimeExecutable } from '../src/runtime/bootstrap.ts'
import { PROTOCOL_VERSION } from '../src/protocol/version.ts'

const directories: string[] = []
const pids: number[] = []
const servers: Array<{ stop(force?: boolean): void | Promise<void> }> = []

function temporary(): string {
  const path = mkdtempSync(join(tmpdir(), 'hw-upgrade-'))
  directories.push(path)
  return path
}

afterEach(async () => {
  for (const pid of pids.splice(0)) {
    try { process.kill(pid) } catch {}
  }
  for (const server of servers.splice(0)) await server.stop(true)
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function fakeRuntimeSource(marker: string): string {
  return `#!/usr/bin/env bun
const marker = ${JSON.stringify(marker)}
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const directory = process.env.HEDDLEWORK_RUNTIME_DIR
if (!directory) throw new Error('missing runtime dir')
const workspacePath = process.env.HEDDLEWORK_CWD ?? process.cwd()
const instanceId = crypto.randomUUID()
const token = 'fake-runtime-token'
const protocol = ${PROTOCOL_VERSION}
const version = '0.1.4'
const executable = process.argv[1] ?? process.execPath
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const header = request.headers.get('authorization') ?? ''
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    if (bearer !== token) return new Response('Unauthorized', { status: 401 })
    const url = new URL(request.url)
    if (url.pathname === '/status' && request.method === 'GET') {
      return Response.json({ instanceId, busy: false, protocol, version, marker })
    }
    if (url.pathname === '/upgrade' && request.method === 'POST') {
      setTimeout(exit, 50)
      return Response.json({ ok: true })
    }
    return new Response('Not found', { status: 404 })
  },
})
function exit() {
  try {
    const saved = JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8'))
    if (saved.instanceId === instanceId) unlinkSync(join(directory, 'connection.json'))
  } catch {}
  void server.stop(true)
  process.exit(0)
}
process.on('SIGINT', exit)
process.on('SIGTERM', exit)
mkdirSync(directory, { recursive: true })
writeFileSync(join(directory, 'connection.json'), JSON.stringify({
  pid: process.pid, instanceId, protocol, version, executable,
  url: 'http://127.0.0.1:' + server.port,
  controlUrl: 'http://127.0.0.1:' + server.port,
  token, workspacePath,
  supervisor: process.env.HEDDLEWORK_RUNTIME_SUPERVISOR === 'launchd' ? 'launchd' : 'process',
}) + '\\n')
setInterval(() => {}, 1 << 30)
`
}

function writeFakeRuntime(directory: string, marker: string): string {
  const source = join(directory, `fake-runtime-${marker}`)
  writeFileSync(source, fakeRuntimeSource(marker))
  chmodSync(source, 0o700)
  return source
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

async function startPredecessor(directory: string, options: {
  protocol: number
  busy?: boolean | (() => boolean)
  executable?: string
  version?: string
  workspacePath?: string
  upgradeStatus?: number
}): Promise<{ instanceId: string; pid: number; upgradePosts: { count: number } }> {
  const hold = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 1000)'], { stdout: 'ignore', stderr: 'ignore' })
  pids.push(hold.pid!)
  const instanceId = crypto.randomUUID()
  const token = `tok-${instanceId}`
  const upgradePosts = { count: 0 }
  const isBusy = typeof options.busy === 'function' ? options.busy : () => options.busy === true
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const header = request.headers.get('authorization') ?? ''
      if (header !== `Bearer ${token}`) return new Response('Unauthorized', { status: 401 })
      const url = new URL(request.url)
      if (url.pathname === '/status' && request.method === 'GET') {
        return Response.json({ instanceId, busy: isBusy(), protocol: options.protocol, version: options.version ?? '0.1.4' })
      }
      if (url.pathname === '/upgrade' && request.method === 'POST') {
        upgradePosts.count++
        if (isBusy() || options.upgradeStatus === 409) return new Response('Agents are busy', { status: 409 })
        if (options.upgradeStatus === 501) return new Response('Upgrade unavailable', { status: 501 })
        setTimeout(() => {
          try { hold.kill() } catch {}
          try { unlinkSync(join(directory, 'connection.json')) } catch {}
        }, 30)
        return Response.json({ ok: true })
      }
      return new Response('Not found', { status: 404 })
    },
  })
  servers.push(server)
  writeFileSync(join(directory, 'connection.json'), JSON.stringify({
    pid: hold.pid,
    instanceId,
    protocol: options.protocol,
    version: options.version ?? '0.1.4',
    executable: options.executable ?? '/old/heddlework-runtime',
    url: `http://127.0.0.1:${server.port}`,
    controlUrl: `http://127.0.0.1:${server.port}`,
    token,
    workspacePath: options.workspacePath ?? directory,
    supervisor: 'process',
  }))
  return { instanceId, pid: hold.pid!, upgradePosts }
}

describe('runtime idle upgrade', () => {
  it('reuses a compatible runtime without hashing when refresh is unset', async () => {
    const directory = temporary()
    const instanceId = 'warm-instance'
    writeFileSync(join(directory, 'connection.json'), JSON.stringify({
      pid: process.pid,
      instanceId,
      protocol: PROTOCOL_VERSION,
      version: '0.1.4',
      executable: '/does-not-exist/heddlework-runtime',
      url: 'http://127.0.0.1:9',
      controlUrl: 'http://127.0.0.1:9',
      token: 'token',
      workspacePath: directory,
      supervisor: 'process',
    }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.endsWith('/upgrade')) throw new Error('warm attach must not POST /upgrade')
      return new Response(JSON.stringify({ instanceId, busy: false, protocol: PROTOCOL_VERSION, version: '0.1.4' }))
    }) as typeof fetch
    try {
      const descriptor = await attachOrStartRuntime({
        workspacePath: directory,
        directory,
        executable: join(directory, 'missing-source-would-throw-if-hashed'),
        supervisor: 'process',
        timeoutMs: 1_000,
        busyWaitMs: 0,
      })
      expect(descriptor.instanceId).toBe(instanceId)
      expect(descriptor.pid).toBe(process.pid)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('defers a busy protocol mismatch without POST /upgrade or stopping the live pid', async () => {
    const directory = temporary()
    const source = join(directory, 'bundle', 'heddlework-runtime')
    mkdirSync(join(directory, 'bundle'), { recursive: true })
    writeFileSync(source, 'staged-but-not-spawned')
    const predecessor = await startPredecessor(directory, { protocol: 1, busy: true })
    await expect(attachOrStartRuntime({
      workspacePath: directory,
      directory,
      executable: source,
      supervisor: 'process',
      timeoutMs: 1_000,
      busyWaitMs: 0,
    })).rejects.toBeInstanceOf(RuntimeUpgradeDeferredError)
    expect(predecessor.upgradePosts.count).toBe(0)
    expect(() => process.kill(predecessor.pid, 0)).not.toThrow()
    expect(JSON.parse(await Bun.file(join(directory, 'connection.json')).text()).instanceId).toBe(predecessor.instanceId)
  })

  it('defers a 409 upgrade race without killing the live runtime', async () => {
    const directory = temporary()
    const source = join(directory, 'heddlework-runtime')
    writeFileSync(source, 'staged-but-not-spawned')
    const predecessor = await startPredecessor(directory, { protocol: 1, busy: false, upgradeStatus: 409 })
    await expect(attachOrStartRuntime({
      workspacePath: directory,
      directory,
      executable: source,
      supervisor: 'process',
      timeoutMs: 1_000,
      busyWaitMs: 0,
    })).rejects.toBeInstanceOf(RuntimeUpgradeDeferredError)
    expect(predecessor.upgradePosts.count).toBe(1)
    expect(() => process.kill(predecessor.pid, 0)).not.toThrow()
    expect(JSON.parse(await Bun.file(join(directory, 'connection.json')).text()).instanceId).toBe(predecessor.instanceId)
  })

  it('stages first then upgrades an idle protocol mismatch to a new instance', async () => {
    const directory = temporary()
    const workspace = join(directory, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const source = writeFakeRuntime(directory, 'protocol-mismatch')
    const predecessor = await startPredecessor(directory, { protocol: 1, busy: false, workspacePath: workspace })
    const descriptor = await attachOrStartRuntime({
      workspacePath: join(directory, 'unused-cwd'),
      directory,
      executable: source,
      supervisor: 'process',
      timeoutMs: 8_000,
      busyWaitMs: 0,
    })
    pids.push(descriptor.pid)
    expect(descriptor.instanceId).not.toBe(predecessor.instanceId)
    expect(descriptor.protocol).toBe(PROTOCOL_VERSION)
    expect(descriptor.pid).not.toBe(predecessor.pid)
    expect(descriptor.workspacePath).toBe(workspace)
    expect(descriptor.executable).toContain('/versions/')
    expect(predecessor.upgradePosts.count).toBe(1)
    expect(() => process.kill(predecessor.pid, 0)).toThrow()
  }, 15_000)

  it('refreshes an idle same-protocol runtime onto the staged executable', async () => {
    const directory = temporary()
    const source = writeFakeRuntime(directory, 'refresh-new')
    const predecessor = await startPredecessor(directory, {
      protocol: PROTOCOL_VERSION,
      busy: false,
      executable: join(directory, 'versions', 'oldhash', 'heddlework-runtime'),
    })
    const descriptor = await attachOrStartRuntime({
      workspacePath: directory,
      directory,
      executable: source,
      supervisor: 'process',
      timeoutMs: 8_000,
      busyWaitMs: 0,
      refresh: true,
    })
    pids.push(descriptor.pid)
    expect(descriptor.instanceId).not.toBe(predecessor.instanceId)
    expect(descriptor.protocol).toBe(PROTOCOL_VERSION)
    expect(descriptor.executable).toContain('/versions/')
    expect(descriptor.executable).not.toContain('/oldhash/')
    expect(predecessor.upgradePosts.count).toBe(1)
  }, 15_000)

  it('reuses a same-identity runtime on refresh without POST /upgrade', async () => {
    const directory = temporary()
    const bundle = join(directory, 'bundle')
    mkdirSync(bundle, { recursive: true })
    const source = join(bundle, 'heddlework-runtime')
    writeFileSync(source, fakeRuntimeSource('same-identity'))
    chmodSync(source, 0o700)
    const staged = stageRuntimeExecutable(source, directory)
    const predecessor = await startPredecessor(directory, {
      protocol: PROTOCOL_VERSION,
      busy: false,
      executable: staged,
    })
    const descriptor = await attachOrStartRuntime({
      workspacePath: directory,
      directory,
      executable: source,
      supervisor: 'process',
      timeoutMs: 1_000,
      busyWaitMs: 0,
      refresh: true,
    })
    expect(descriptor.instanceId).toBe(predecessor.instanceId)
    expect(descriptor.pid).toBe(predecessor.pid)
    expect(predecessor.upgradePosts.count).toBe(0)
  })

  it('defers a busy same-protocol refresh without stopping the live pid', async () => {
    const directory = temporary()
    const source = writeFakeRuntime(directory, 'busy-refresh')
    const predecessor = await startPredecessor(directory, {
      protocol: PROTOCOL_VERSION,
      busy: true,
      executable: join(directory, 'versions', 'oldhash', 'heddlework-runtime'),
    })
    await expect(attachOrStartRuntime({
      workspacePath: directory,
      directory,
      executable: source,
      supervisor: 'process',
      timeoutMs: 1_000,
      busyWaitMs: 0,
      refresh: true,
    })).rejects.toBeInstanceOf(RuntimeUpgradeDeferredError)
    expect(predecessor.upgradePosts.count).toBe(0)
    expect(() => process.kill(predecessor.pid, 0)).not.toThrow()
  })
})
