import { afterEach, describe, expect, it } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getPiSessionDirectory, listPiSessions } from '../src/pi/session-catalog.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('PiSessionCatalog', () => {
  it('lists persisted sessions with latest names and user-message fallback titles', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-workbench-catalog-'))
    roots.push(root)
    const agentDir = join(root, 'agent')
    const cwd = join(root, 'project')
    const directory = getPiSessionDirectory(cwd, agentDir)
    await mkdir(directory, { recursive: true })

    await writeFile(join(directory, '2026-01-01_old.jsonl'), [
      JSON.stringify({ type: 'session', id: 'old', cwd, timestamp: '2026-01-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:01:00.000Z', message: { role: 'user', content: 'Explain this repository', timestamp: Date.parse('2026-01-01T00:01:00.000Z') } }),
      JSON.stringify({ type: 'message', timestamp: '2026-01-01T00:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Okay' }], timestamp: Date.parse('2026-01-01T00:02:00.000Z') } }),
    ].join('\n'))
    await writeFile(join(directory, '2026-02-01_new.jsonl'), [
      JSON.stringify({ type: 'session', id: 'new', cwd, timestamp: '2026-02-01T00:00:00.000Z' }),
      JSON.stringify({ type: 'message', timestamp: '2026-02-01T00:01:00.000Z', message: { role: 'user', content: 'Initial title' } }),
      JSON.stringify({ type: 'session_info', name: 'Named thread' }),
    ].join('\n'))
    await writeFile(join(directory, 'broken.jsonl'), '{not json}\n')

    const sessions = await listPiSessions(cwd, { agentDir })
    expect(sessions.map((session) => session.id)).toEqual(['new', 'old'])
    expect(sessions[0]).toMatchObject({ title: 'Named thread', name: 'Named thread', messageCount: 1 })
    expect(sessions[1]).toMatchObject({ title: 'Explain this repository', firstMessage: 'Explain this repository', messageCount: 2 })
  })
})
