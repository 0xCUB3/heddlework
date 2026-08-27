import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PiSessionHistoryPager } from '../src/pi/session-history.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('PiSessionHistoryPager', () => {
  it('pages backward through only the active branch across compaction and custom entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-history-'))
    directories.push(directory)
    const path = join(directory, 'session.jsonl')
    const entries = [
      { type: 'session', version: 3, id: 'session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'First prompt', timestamp: 1 } },
      { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }], timestamp: 2 } },
      { type: 'message', id: 'abandoned', parentId: 'a1', message: { role: 'user', content: 'Abandoned branch', timestamp: 3 } },
      { type: 'compaction', id: 'compact', parentId: 'a1', summary: 'summary' },
      { type: 'custom_message', id: 'hidden', parentId: 'compact', customType: 'hidden', content: 'ignore', display: false },
      { type: 'message', id: 'u2', parentId: 'hidden', message: { role: 'user', content: 'Second prompt', timestamp: 4 } },
      { type: 'custom_message', id: 'visible', parentId: 'u2', customType: 'sync', content: 'Visible context', display: true, timestamp: '2026-01-01T00:00:05.000Z' },
      { type: 'message', id: 'a2', parentId: 'visible', message: { role: 'assistant', content: 'Second answer', timestamp: 6 } },
    ]
    await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const pager = new PiSessionHistoryPager(path)
    const newest = await pager.loadEarlier(3)
    expect(newest.messages.map((message) => message.content)).toEqual(['Second prompt', 'Visible context', 'Second answer'])
    expect(newest.messages.map((message) => message.workbenchEntryId)).toEqual(['u2', 'visible', 'a2'])
    expect(newest.hasOlder).toBe(true)

    const oldest = await pager.loadEarlier(3)
    expect(oldest.messages.map((message) => message.content)).toEqual(['First prompt', [{ type: 'text', text: 'First answer' }]])
    expect(oldest.messages.some((message) => message.content === 'Abandoned branch')).toBe(false)
    expect(oldest.hasOlder).toBe(false)
  })

  it('scans through collapsed work until a navigable conversation page is available', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-semantic-history-'))
    directories.push(directory)
    const path = join(directory, 'session.jsonl')
    const entries: Array<Record<string, unknown>> = [
      { type: 'session', version: 3, id: 'session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' },
    ]
    let parentId: string | null = null
    const append = (id: string, message: Record<string, unknown>) => {
      entries.push({ type: 'message', id, parentId, message })
      parentId = id
    }
    append('u1', { role: 'user', content: 'First prompt', timestamp: 1 })
    append('a1', { role: 'assistant', content: 'First answer', timestamp: 2 })
    for (let index = 0; index < 12; index += 1) append(`tool-${index}`, { role: 'toolResult', toolCallId: `call-${index}`, toolName: 'read', content: `hidden result ${index}`, timestamp: 3 + index })
    append('u2', { role: 'user', content: 'Second prompt', timestamp: 20 })
    append('a2', { role: 'assistant', content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: 'Second answer' }], timestamp: 21 })
    await writeFile(path, `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`)

    const pager = new PiSessionHistoryPager(path)
    const page = await pager.loadEarlier(3, { minimumConversationMessages: 4, maximumMessages: 20 })

    expect(page.messages).toHaveLength(16)
    expect(page.messages.filter((message) => message.role === 'user' || message.role === 'assistant').map((message) => message.workbenchEntryId)).toEqual(['u1', 'a1', 'u2', 'a2'])
    expect(page.hasOlder).toBe(false)

    const cappedPage = await new PiSessionHistoryPager(path).loadEarlier(3, { minimumConversationMessages: 4, maximumMessages: 8 })
    expect(cappedPage.messages).toHaveLength(8)
    expect(cappedPage.hasOlder).toBe(true)
  })
})
