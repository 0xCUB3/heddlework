import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compareSessionsByActivity, getPiSessionDirectory, getPiSessionRoot, isCurrentPiSession, listPiSessions, PiSessionCatalog } from '../src/pi/session-catalog.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PiSessionCatalog', () => {
  it('creates blank target-workspace sessions and persists fresh sidebar summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-cache-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const cachePath = join(root, 'sessions.json')
    const cwd = join(root, 'target-project')
    const catalog = new PiSessionCatalog({ agentDir, cachePath })

    const created = await catalog.createWorkspaceSession(cwd)
    expect(JSON.parse(await readFile(created.path, 'utf8'))).toMatchObject({ type: 'session', version: 3, id: created.id, cwd })
    const scanned = await catalog.list(cwd)
    expect(scanned).toHaveLength(1)
    expect(scanned[0]).toMatchObject({ id: created.id, cwd, title: 'New thread', messageCount: 0 })

    const hydrated = new PiSessionCatalog({ agentDir, cachePath }).cached(cwd)
    expect(hydrated).toEqual(scanned)
  })

  it('lists persisted sessions with latest names and user-message fallback titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const directory = getPiSessionDirectory(cwd, agentDir)
    await mkdir(directory, { recursive: true })

    const oldPath = join(directory, '2026-01-01_old.jsonl')
    await writeFile(oldPath, [
      JSON.stringify({ type: 'session', id: 'old', cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'user', content: 'Explain this repository', timestamp: Date.parse('2026-01-01T00:01:00.000Z') } }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Okay' }], timestamp: Date.parse('2026-01-01T00:02:00.000Z') } }),
    ].join('\n'))
    await writeFile(join(directory, '2026-02-01_new.jsonl'), [
      JSON.stringify({ type: 'session', id: 'new', cwd, parentSession: '/tmp/parent-session.jsonl', timestamp: '2026-02-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-02-01T00:01:00.000Z', message: { role: 'user', content: 'Initial title' } }),
      JSON.stringify({ type: 'message', timestamp: '2026-02-01T00:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Newest response' }], stopReason: 'stop' } }),
      JSON.stringify({ type: 'session_info', name: 'Named thread' }),
    ].join('\n'))
    await writeFile(join(directory, 'broken.jsonl'), '{not json}\n')
    const openedLater = new Date('2026-12-01T00:00:00.000Z')
    await utimes(oldPath, openedLater, openedLater)

    const sessions = await listPiSessions(cwd, { agentDir })
    expect(sessions.map((session) => session.id)).toEqual(['new', 'old'])
    expect(sessions[0]).toMatchObject({ title: 'Named thread', name: 'Named thread', messageCount: 2, modifiedAt: Date.parse('2026-02-01T00:02:00.000Z'), parentSession: '/tmp/parent-session.jsonl', lastAssistantText: 'Newest response', lastAssistantStopReason: 'stop' })
    expect(sessions[1]).toMatchObject({ title: 'Explain this repository', firstMessage: 'Explain this repository', messageCount: 2, modifiedAt: Date.parse('2026-01-01T00:02:00.000Z') })
  })

  it('loads every project and skips large message bodies after the first prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-all-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const currentCwd = join(root, 'project-a')
    const otherCwd = join(root, 'project-b')
    const currentDirectory = getPiSessionDirectory(currentCwd, agentDir)
    const otherDirectory = getPiSessionDirectory(otherCwd, agentDir)
    await Promise.all([mkdir(currentDirectory, { recursive: true }), mkdir(otherDirectory, { recursive: true })])

    await Promise.all(Array.from({ length: 105 }, (_, index) => {
      const cwd = index % 2 === 0 ? currentCwd : otherCwd
      const directory = index % 2 === 0 ? currentDirectory : otherDirectory
      return writeFile(join(directory, `${String(index).padStart(3, '0')}.jsonl`), [
        JSON.stringify({ type: 'session', id: `session-${index}`, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
        JSON.stringify({ type: 'message', message: { role: 'user', content: `Prompt ${index}` } }),
      ].join('\n'))
    }))
    await writeFile(join(otherDirectory, 'large.jsonl'), [
      JSON.stringify({ type: 'session', id: 'large', cwd: otherCwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Large session prompt' } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(2_000_000) }] } }),
      JSON.stringify({ type: 'session_info', name: 'Tail rename' }),
    ].join('\n'))

    const pageStartedAt = performance.now()
    const firstPage = await listPiSessions(currentCwd, { agentDir, limit: 25 })
    expect(firstPage).toHaveLength(25)
    expect(performance.now() - pageStartedAt).toBeLessThan(1_000)

    const startedAt = performance.now()
    const sessions = await listPiSessions(currentCwd, { agentDir })
    expect(sessions).toHaveLength(106)
    expect(new Set(sessions.map((session) => session.cwd))).toEqual(new Set([currentCwd, otherCwd]))
    expect(sessions.find((session) => session.id === 'large')).toMatchObject({ title: 'Tail rename', firstMessage: 'Large session prompt', messageCount: 1 })
    expect(performance.now() - startedAt).toBeLessThan(2_500)
  })
})

describe('isCurrentPiSession', () => {
  const session = { id: 'one', path: '/tmp/one.jsonl' }

  it('matches the open session file even when ids collide', () => {
    expect(isCurrentPiSession(session, { sessionId: 'one', sessionFile: '/tmp/one.jsonl' })).toBe(true)
    expect(isCurrentPiSession({ id: 'one', path: '/tmp/fork.jsonl' }, { sessionId: 'one', sessionFile: '/tmp/one.jsonl' })).toBe(false)
  })

  it('falls back to id only when the live session has no file yet', () => {
    expect(isCurrentPiSession(session, { sessionId: 'one' })).toBe(true)
    expect(isCurrentPiSession(session, { sessionId: 'two' })).toBe(false)
    expect(isCurrentPiSession(session, {})).toBe(false)
  })
})

describe('PiSessionCatalog incremental index', () => {
  it('updates one dirty path among many without restatting the catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-dirty-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const directory = getPiSessionDirectory(cwd, agentDir)
    await mkdir(directory, { recursive: true })
    await Promise.all(Array.from({ length: 1200 }, (_, index) => writeFile(join(directory, index.toString().padStart(4, '0') + '.jsonl'), [
      JSON.stringify({ type: 'session', id: 'session-' + index, cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Prompt ' + index } }),
    ].join('\n'))))

    let emit: (paths: string[]) => void = () => undefined
    const catalog = new PiSessionCatalog({
      agentDir,
      cachePath: false,
      watchSessions: (_directory, changed) => {
        emit = changed
        return () => undefined
      },
    })
    const first = await catalog.list(cwd)
    expect(first).toHaveLength(1200)
    const unchanged = first.find((session) => session.id === 'session-0')
    const target = first.find((session) => session.id === 'session-500')
    expect(unchanged).toBeDefined()
    expect(target).toBeDefined()
    catalog.subscribe(cwd, () => undefined)

    const targetPath = target!.path
    await writeFile(targetPath, [
      JSON.stringify({ type: 'session', id: 'session-500', cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Prompt 500' } }),
      JSON.stringify({ type: 'session_info', name: 'Renamed in place' }),
    ].join('\n'))
    const statsBefore = catalog.statCount
    emit([targetPath])
    const next = await catalog.list(cwd)
    expect(catalog.statCount - statsBefore).toBeLessThan(8)
    expect(next.find((session) => session.id === 'session-0')).toBe(unchanged)
    expect(next.find((session) => session.id === 'session-500')).toMatchObject({ title: 'Renamed in place', name: 'Renamed in place' })
    expect(next.find((session) => session.id === 'session-500')).not.toBe(target)
  })

  it('handles create, delete, and rename through dirty paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-rename-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const directory = getPiSessionDirectory(cwd, agentDir)
    await mkdir(directory, { recursive: true })
    const keepPath = join(directory, 'keep.jsonl')
    const oldPath = join(directory, 'old.jsonl')
    await writeFile(keepPath, JSON.stringify({ type: 'session', id: 'keep', cwd, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
    await writeFile(oldPath, JSON.stringify({ type: 'session', id: 'old', cwd, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')

    let emit: (paths: string[]) => void = () => undefined
    const catalog = new PiSessionCatalog({
      agentDir,
      cachePath: false,
      watchSessions: (_directory, changed) => {
        emit = changed
        return () => undefined
      },
    })
    const first = await catalog.list(cwd)
    const keep = first.find((session) => session.id === 'keep')
    catalog.subscribe(cwd, () => undefined)

    const createdPath = join(directory, 'created.jsonl')
    await writeFile(createdPath, JSON.stringify({ type: 'session', id: 'created', cwd, timestamp: '2026-03-01T00:00:00.000Z' }) + '\n')
    emit([createdPath])
    expect((await catalog.list(cwd)).map((session) => session.id).sort()).toEqual(['created', 'keep', 'old'])

    const renamedPath = join(directory, 'renamed.jsonl')
    await rename(oldPath, renamedPath)
    emit([oldPath, renamedPath])
    const afterRename = await catalog.list(cwd)
    expect(afterRename.find((session) => session.id === 'keep')).toBe(keep)
    expect(afterRename.map((session) => session.id).sort()).toEqual(['created', 'keep', 'old'])
    expect(afterRename.find((session) => session.id === 'old')?.path).toBe(renamedPath)

    await rm(createdPath)
    emit([createdPath])
    const afterDelete = await catalog.list(cwd)
    expect(afterDelete.find((session) => session.id === 'keep')).toBe(keep)
    expect(afterDelete.map((session) => session.id).sort()).toEqual(['keep', 'old'])
  })

  it('re-reads a dirty path even when mtime and size are unchanged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-mtime-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const directory = getPiSessionDirectory(cwd, agentDir)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'same-size.jsonl')
    const first = [
      JSON.stringify({ type: 'session', id: 'same', cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Prompt' } }),
      JSON.stringify({ type: 'session_info', name: 'Title AAA' }),
    ].join('\n') + '\n'
    const second = [
      JSON.stringify({ type: 'session', id: 'same', cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', message: { role: 'user', content: 'Prompt' } }),
      JSON.stringify({ type: 'session_info', name: 'Title BBB' }),
    ].join('\n') + '\n'
    expect(first.length).toBe(second.length)
    await writeFile(path, first)
    const stats = await stat(path)
    let emit: (paths: string[]) => void = () => undefined
    const catalog = new PiSessionCatalog({
      agentDir,
      cachePath: false,
      watchSessions: (_directory, changed) => {
        emit = changed
        return () => undefined
      },
    })
    expect((await catalog.list(cwd))[0]?.title).toBe('Title AAA')
    catalog.subscribe(cwd, () => undefined)
    await writeFile(path, second)
    await utimes(path, stats.atime, stats.mtime)
    emit([path])
    expect((await catalog.list(cwd))[0]?.title).toBe('Title BBB')
  })

  it('indexes nested project directories from a directory dirty path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-nested-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const directory = getPiSessionDirectory(cwd, agentDir)
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, 'keep.jsonl'), JSON.stringify({ type: 'session', id: 'keep', cwd, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n')
    let emit: (paths: string[]) => void = () => undefined
    const catalog = new PiSessionCatalog({
      agentDir,
      cachePath: false,
      watchSessions: (_directory, changed) => {
        emit = changed
        return () => undefined
      },
    })
    await catalog.list(cwd)
    catalog.subscribe(cwd, () => undefined)
    const otherCwd = join(root, 'other-project')
    const nested = getPiSessionDirectory(otherCwd, agentDir)
    await mkdir(nested, { recursive: true })
    await writeFile(join(nested, 'nested.jsonl'), JSON.stringify({ type: 'session', id: 'nested', cwd: otherCwd, timestamp: '2026-04-01T00:00:00.000Z' }) + '\n')
    emit([nested])
    const listed = await catalog.list(cwd)
    expect(listed.map((session) => session.id).sort()).toEqual(['keep', 'nested'])
  })

  it('watches the agent session root rather than the workspace home path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-catalog-root-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const watched: string[] = []
    const catalog = new PiSessionCatalog({
      agentDir,
      cachePath: false,
      watchSessions: (directory) => {
        watched.push(directory)
        return () => undefined
      },
    })
    catalog.subscribe(join(root, 'Users', 'home'), () => undefined)
    expect(watched).toEqual([getPiSessionRoot(agentDir)])
  })
})

describe('compareSessionsByActivity', () => {
  it('orders equal recency by path', () => {
    const left = { id: 'z', path: '/tmp/z.jsonl', cwd: '/tmp', title: 'Z', firstMessage: '', messageCount: 1, createdAt: 1, modifiedAt: 5 }
    const right = { id: 'a', path: '/tmp/a.jsonl', cwd: '/tmp', title: 'A', firstMessage: '', messageCount: 1, createdAt: 1, modifiedAt: 5 }
    expect(compareSessionsByActivity(left, right)).toBeGreaterThan(0)
    expect(compareSessionsByActivity(right, left)).toBeLessThan(0)
  })
})
