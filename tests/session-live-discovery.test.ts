import { afterEach, describe, expect, it } from 'bun:test'
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { getPiSessionDirectory, PiSessionCatalog } from '../src/pi/session-catalog.ts'
import type { PiLiveBridgeAdvertisement } from '../src/pi/live-bridge.ts'
import { watchPiSessions } from '../src/pi/session-watch.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'heddlework-session-live-'))
  roots.push(root)
  const agentDir = join(root, 'agent')
  const cwd = join(root, 'project')
  const directory = getPiSessionDirectory(cwd, agentDir)
  await mkdir(directory, { recursive: true })
  return { root, agentDir, cwd, directory }
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 4_000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Session update did not arrive')
    await Bun.sleep(10)
  }
}
const header = (id: string, cwd: string) => JSON.stringify({ type: 'session', version: 3, id, cwd, timestamp: '2026-09-01T00:00:00Z' }) + '\n'

describe('live session discovery', () => {
  it('discovers an advertised TUI before its first JSONL write without exposing bridge credentials', async () => {
    const { root, agentDir, cwd, directory } = await fixture()
    const liveDirectory = join(root, 'pi-live')
    await mkdir(liveDirectory)
    const cachePath = join(root, 'live-cache.json')
    const catalog = new PiSessionCatalog({ agentDir, cachePath, liveBridgeDirectory: liveDirectory })
    const advertisement: PiLiveBridgeAdvertisement = {
      version: 1, pid: process.pid, port: 12345, token: 'private-token-that-must-not-leak'.repeat(3),
      mode: 'tui', cwd, sessionFile: join(directory, 'not-written-yet.jsonl'),
      sessionId: 'new-live-session', sessionName: 'Live terminal thread', updatedAt: Date.now(),
    }
    let sessions = await catalog.list(cwd)
    const close = catalog.subscribe(cwd, () => { void catalog.list(cwd).then((next) => { sessions = next }) })
    try {
      await writeFile(join(liveDirectory, `${process.pid}.json`), JSON.stringify(advertisement))
      await waitFor(() => sessions.some((session) => session.id === 'new-live-session'))
      expect(sessions[0]).toMatchObject({ title: 'Live terminal thread', live: true })
      expect(JSON.stringify(sessions)).not.toContain(advertisement.token)
      expect(await readFile(cachePath, 'utf8')).not.toContain(advertisement.token)
      await writeFile(advertisement.sessionFile!, header(advertisement.sessionId, cwd))
      const persisted = await catalog.list(cwd)
      expect(persisted).toHaveLength(1)
      expect(persisted[0]?.title).toBe('Live terminal thread')
    } finally { close() }
  })

  it('shares overlapping scans, preserves stable rows, and does not rewrite an unchanged disk cache', async () => {
    const { root, agentDir, cwd, directory } = await fixture()
    await Promise.all(Array.from({ length: 8 }, (_, i) => writeFile(join(directory, `${i}.jsonl`), header(String(i), cwd))))
    const cachePath = join(root, 'cache.json')
    const catalog = new PiSessionCatalog({ agentDir, cachePath })
    const [small, large] = await Promise.all([catalog.list(cwd, 2), catalog.list(cwd, 4)])
    expect(small).toHaveLength(2)
    expect(large).toHaveLength(4)
    expect(small[0]).toBe(large[0])
    expect(catalog.cached(cwd)).toHaveLength(8)
    const before = await stat(cachePath)
    await Bun.sleep(10)
    const again = await catalog.list(cwd)
    expect(again[0]).toBe(small[0])
    expect((await stat(cachePath)).mtimeMs).toBe(before.mtimeMs)
    expect(JSON.parse(await readFile(cachePath, 'utf8')).sessions).toHaveLength(8)
  })

  it('discovers sessions created by a TUI and refreshes names without flickering the loading state', async () => {
    const { agentDir, cwd, directory } = await fixture()
    const catalog = new PiSessionCatalog({ agentDir, cachePath: false })
    const controller = new WorkbenchController(new DemoTransport(), cwd, {
      sessionCatalog: catalog,
      workspaceDiff: { load: async () => ({ status: 'ready', branch: '', files: [], additions: 0, deletions: 0 }) },
    })
    try {
      await controller.start()
      await Bun.sleep(200) // Drain the watcher's initial root notification.
      const loading: boolean[] = []
      controller.subscribe(() => loading.push(controller.getSnapshot().sessionsLoading))
      const path = join(directory, 'tui.jsonl')
      await writeFile(path, header('tui', cwd))
      await waitFor(() => controller.getSnapshot().sessions.some((session) => session.id === 'tui'))
      await appendFile(path, JSON.stringify({ type: 'session_info', name: 'Renamed from TUI' }) + '\n')
      await waitFor(() => controller.getSnapshot().sessions[0]?.name === 'Renamed from TUI')
      expect(loading).not.toContain(true)
    } finally { await controller.dispose() }
  })

  it('recovers a root created after subscription and releases all notifications on unsubscribe', async () => {
    const { root, cwd } = await fixture()
    const directory = join(root, 'later')
    let notifications = 0
    const close = watchPiSessions(directory, () => { notifications++ }, { debounceMs: 10, retryMs: 20 })
    try {
      await Bun.sleep(30)
      await mkdir(directory)
      await writeFile(join(directory, 'one.jsonl'), header('one', cwd))
      await waitFor(() => notifications > 0)
      const count = notifications
      close()
      await appendFile(join(directory, 'one.jsonl'), '\n')
      await Bun.sleep(100)
      expect(notifications).toBe(count)
    } finally { close() }
  })

  it('replays an invalidation that arrives during a scan instead of losing the new session', async () => {
    const { cwd } = await fixture()
    let invalidate!: () => void
    let release!: () => void
    let calls = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    const controller = new WorkbenchController(new DemoTransport(), cwd, {
      sessionCatalog: {
        subscribe: (_cwd, callback) => { invalidate = callback; return () => undefined },
        createWorkspaceSession: async () => { throw new Error('unused') },
        list: async () => { if (++calls === 1) await gate; return [] },
      },
      workspaceDiff: { load: async () => ({ status: 'ready', branch: '', files: [], additions: 0, deletions: 0 }) },
    })
    const starting = controller.start()
    try {
      invalidate()
      release()
      await starting
      await waitFor(() => calls === 2)
      expect(calls).toBe(2)
    } finally { release(); await starting; await controller.dispose() }
  })
})
