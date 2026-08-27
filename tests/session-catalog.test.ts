import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiSessionDirectory, listPiSessions } from '../src/pi/session-catalog.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PiSessionCatalog', () => {
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
      JSON.stringify({ type: 'session', id: 'new', cwd, timestamp: '2026-02-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-02-01T00:01:00.000Z', message: { role: 'user', content: 'Initial title' } }),
      JSON.stringify({ type: 'message', timestamp: '2026-02-01T00:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Newest response' }] } }),
      JSON.stringify({ type: 'session_info', name: 'Named thread' }),
    ].join('\n'))
    await writeFile(join(directory, 'broken.jsonl'), '{not json}\n')
    const openedLater = new Date('2026-12-01T00:00:00.000Z')
    await utimes(oldPath, openedLater, openedLater)

    const sessions = await listPiSessions(cwd, { agentDir })
    expect(sessions.map((session) => session.id)).toEqual(['new', 'old'])
    expect(sessions[0]).toMatchObject({ title: 'Named thread', name: 'Named thread', messageCount: 2, modifiedAt: Date.parse('2026-02-01T00:02:00.000Z') })
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
