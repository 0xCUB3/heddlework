import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { SessionRuntime, type RuntimeSessionBundle } from '../src/host/session-runtime.ts'
import { createInitialState } from '../src/workbench/state.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'heddlework-runtime-lazy-'))
  roots.push(root)
  return { root, path: join(root, 'registry.json') }
}

function stateDirectory(root: string, sessionPath: string): string {
  const key = createHash('sha256').update(sessionPath).digest('hex').slice(0, 24)
  return join(root, 'sessions', key)
}

function bundle(cwd: string, sessionPath?: string, start?: () => Promise<void>) {
  let state = createInitialState(cwd)
  if (sessionPath) state = { ...state, session: { ...state.session, sessionFile: sessionPath } }
  const listeners = new Set<() => void>()
  let starts = 0
  const value = {
    controller: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      start: async () => { starts++; await start?.() },
    },
    flows: { subscribe: () => () => undefined },
    dispose: async () => undefined,
  } as unknown as RuntimeSessionBundle
  return {
    value,
    starts: () => starts,
    setPath(path: string) { state = { ...state, session: { ...state.session, sessionFile: path } } },
    publish() { for (const listener of listeners) listener() },
  }
}

describe('session runtime lazy restoration', () => {
  it('retains 100 saved threads without starting them and opens one in its original workspace', async () => {
    const { root, path } = fixture()
    const saved = Array.from({ length: 100 }, (_, index) => ({
      key: join(root, `${index}.jsonl`), sessionPath: join(root, `${index}.jsonl`),
      id: `saved-${index}`, workspacePath: join(root, `project-${index}`), status: 'active',
    }))
    writeFileSync(path, JSON.stringify({ version: 1, workspacePath: root, sessions: saved }))
    const initial = bundle(root)
    const calls: unknown[] = []
    const opened = bundle(saved[42]!.workspacePath, saved[42]!.sessionPath)
    const runtime = new SessionRuntime({ initial: initial.value, path, createSession: async (input) => {
      calls.push(input)
      return opened.value
    } })
    try {
      await runtime.startInitial()
      expect(calls).toHaveLength(0)
      expect(initial.starts()).toBe(1)
      expect(runtime.isBusy()).toBe(false)
      expect(JSON.parse(readFileSync(path, 'utf8')).sessions).toHaveLength(101)
      expect(await runtime.ensureSession(saved[42]!.sessionPath)).toBe(opened.value)
      expect(calls).toEqual([{ workspacePath: saved[42]!.workspacePath, sessionPath: saved[42]!.sessionPath, id: 'saved-42' }])
      expect(opened.starts()).toBe(1)
      expect(JSON.parse(readFileSync(path, 'utf8')).sessions).toHaveLength(101)
    } finally { await runtime.dispose() }
  })

  it('concurrent opens both wait for the same in-progress startup', async () => {
    const { root, path } = fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const opened = bundle(root, join(root, 'thread.jsonl'), () => gate)
    let creations = 0
    const runtime = new SessionRuntime({ initial: bundle(root).value, path, createSession: async () => {
      creations++
      return opened.value
    } })
    const first = runtime.ensureSession(join(root, 'thread.jsonl'))
    try {
      await Bun.sleep(0)
      let secondReady = false
      const second = runtime.ensureSession(join(root, 'thread.jsonl')).then((value) => { secondReady = true; return value })
      await Bun.sleep(0)
      expect(secondReady).toBe(false)
      expect(creations).toBe(1)
      release()
      expect(await first).toBe(await second)
      expect(opened.starts()).toBe(1)
    } finally { release(); await first; await runtime.dispose() }
  })

  it('publishes the current routing key after the initial session acquires its path', async () => {
    const { root, path } = fixture()
    const sessionPath = join(root, 'initial.jsonl')
    const initial = bundle(root, undefined, async () => initial.setPath(sessionPath))
    const runtime = new SessionRuntime({ initial: initial.value, path, createSession: async () => initial.value })
    const keys: string[] = []
    runtime.subscribeSnapshots((key) => keys.push(key))
    try {
      await runtime.startInitial()
      initial.publish()
      expect(runtime.defaultSessionKey).toBe(sessionPath)
      expect(keys).toEqual([sessionPath])
    } finally { await runtime.dispose() }
  })

  it('eagerly restores only sessions with durable background work', async () => {
    const { root, path } = fixture()
    const scheduledPath = join(root, 'scheduled.jsonl')
    const queuedPath = join(root, 'queued.jsonl')
    const idlePath = join(root, 'idle.jsonl')
    const sessions = [scheduledPath, queuedPath, idlePath].map((sessionPath) => ({
      key: sessionPath, sessionPath, id: sessionPath, workspacePath: root, status: 'active',
    }))
    writeFileSync(path, JSON.stringify({ version: 1, workspacePath: root, sessions }))
    for (const sessionPath of [scheduledPath, queuedPath]) mkdirSync(stateDirectory(root, sessionPath), { recursive: true })
    const scheduledDir = stateDirectory(root, scheduledPath)
    const queuedDir = stateDirectory(root, queuedPath)
    await Bun.write(join(scheduledDir, 'flows.json'), JSON.stringify({
      version: 1,
      schedules: [{ id: 's', title: 's', prompts: ['x'], mode: 'sequential', workspacePath: root, enabled: true, createdAt: 1, updatedAt: 1, timing: { kind: 'interval', everyMs: 60_000 } }],
      pending: [], runs: [],
    }))
    await Bun.write(join(queuedDir, 'queue.json'), JSON.stringify({ version: 1, workspaces: { [root]: { items: [{ id: 'q' }] } } }))
    const created: string[] = []
    const runtime = new SessionRuntime({
      initial: bundle(root).value,
      path,
      createSession: async (input) => {
        created.push(input.sessionPath!)
        return bundle(root, input.sessionPath).value
      },
    })
    try {
      await runtime.startInitial()
      for (let attempt = 0; attempt < 20 && created.length < 2; attempt++) await Bun.sleep(0)
      expect(created.toSorted()).toEqual([queuedPath, scheduledPath].toSorted())
      expect(runtime.bundleForKey(idlePath)).toBeUndefined()
    } finally { await runtime.dispose() }
  })

  it('reindexes a live owner when its controller switches session files externally', async () => {
    const { root, path } = fixture()
    const oldPath = join(root, 'old.jsonl')
    const newPath = join(root, 'new.jsonl')
    const owner = bundle(root, oldPath)
    const replacement = bundle(root, oldPath)
    let created = 0
    const runtime = new SessionRuntime({
      initial: owner.value,
      path,
      createSession: async () => { created++; return replacement.value },
    })
    const migrations: Array<[string, string]> = []
    runtime.subscribeSessionKeys((from, to) => migrations.push([from, to]))
    try {
      await runtime.startInitial()
      owner.setPath(newPath)
      owner.publish()

      expect(runtime.bundleForKey(oldPath)).toBeUndefined()
      expect(runtime.bundleForKey(newPath)).toBe(owner.value)
      expect(runtime.defaultSessionKey).toBe(newPath)
      expect(migrations).toEqual([[oldPath, newPath]])

      expect(await runtime.ensureSession(oldPath)).toBe(replacement.value)
      expect(created).toBe(1)
      expect(runtime.bundleForKey(oldPath)).toBe(replacement.value)
      expect(runtime.bundleForKey(newPath)).toBe(owner.value)
    } finally { await runtime.dispose() }
  })
})
