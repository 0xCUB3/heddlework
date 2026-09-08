import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { isSessionHistoryStub, PiSessionHistoryPager } from '../src/pi/session-history.ts'

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })

describe('PiSessionHistoryPager', () => {
  it('projects structured turn telemetry but keeps unknown custom state private', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-telemetry-'))
    directories.push(directory)
    const path = join(directory, 'session.jsonl')
    const entries = [
      { type: 'message', id: 'a', parentId: null, message: { role: 'assistant', content: 'Done' } },
      { type: 'custom', id: 'private', parentId: 'a', customType: 'private-state', data: { secret: 'do not render' } },
      { type: 'custom', id: 'metrics', parentId: 'private', customType: 'tps', data: { tps: 50, timing: { totalMs: 1000 }, tokens: { output: 50 } } },
      { type: 'custom_message', id: 'visible', parentId: 'metrics', content: 'Public result', display: true, details: { version: 1 } },
    ]
    await writeFile(path, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n')
    const result = await new PiSessionHistoryPager(path).loadEarlier(10)
    expect(result.messages).toHaveLength(3)
    expect(result.messages[1]).toMatchObject({ role: 'telemetry', content: 'TPS 50.0 · 1.0s · out 50', workbenchEntryId: 'metrics' })
    expect(result.messages[2]).toMatchObject({ role: 'custom', details: { version: 1 } })
    expect(JSON.stringify(result)).not.toContain('do not render')
  })
  it('pages backward through only the active branch across compaction and custom entries', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-history-'))
    directories.push(directory)
    const path = join(directory, 'session.jsonl')
    const entries = [
      { type: 'session', version: 3, id: 'session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' },
      { type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'First prompt', timestamp: 1 } },
      { type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'First answer' }], timestamp: 2 } },
      { type: 'message', id: 'abandoned', parentId: 'a1', message: { role: 'user', content: 'Abandoned branch', timestamp: 3 } },
      { type: 'compaction', id: 'compact', parentId: 'a1', summary: 'summary', tokensBefore: 50000, timestamp: '2026-01-01T00:00:03.000Z' },
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
    expect(oldest.messages.map((message) => message.content)).toEqual(['First prompt', [{ type: 'text', text: 'First answer' }], 'summary'])
    expect(oldest.messages.at(-1)).toMatchObject({ role: 'compaction', tokensBefore: 50000, workbenchEntryId: 'compact' })
    expect(oldest.messages.some((message) => message.content === 'Abandoned branch')).toBe(false)
    expect(oldest.hasOlder).toBe(false)

    const abandoned = await new PiSessionHistoryPager(path, 'abandoned').loadEarlier(10)
    expect(abandoned.messages.map((message) => message.content)).toEqual(['First prompt', [{ type: 'text', text: 'First answer' }], 'Abandoned branch'])
    expect(abandoned.messages.map((message) => message.workbenchEntryId)).toEqual(['u1', 'a1', 'abandoned'])

    const root = await new PiSessionHistoryPager(path, null).loadEarlier(10)
    expect(root).toEqual({ messages: [], hasOlder: false })
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

  it('scans a 16 MiB hidden record linearly and keeps the branch', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-history-hidden-'))
    directories.push(directory)
    const path = join(directory, 'session.jsonl')
    const hidden = 'x'.repeat(16 * 1024 * 1024)
    const entries = [
      { type: 'message', id: 'before', parentId: null, message: { role: 'user', content: 'before' } },
      { type: 'custom_message', id: 'hidden', parentId: 'before', customType: 'blob', content: hidden, display: false },
      { type: 'message', id: 'after', parentId: 'hidden', message: { role: 'assistant', content: 'after' } },
    ]
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
    const originalConcat = Buffer.concat.bind(Buffer)
    let copied = 0
    Buffer.concat = ((list: readonly Uint8Array[], totalLength?: number) => {
      copied += list.reduce((sum, part) => sum + part.length, 0)
      return originalConcat(list, totalLength)
    }) as typeof Buffer.concat
    try {
      const page = await new PiSessionHistoryPager(path).loadEarlier(10)
      expect(page.messages.map((message) => message.content)).toEqual(['before', 'after'])
      expect(JSON.stringify(page)).not.toContain(hidden.slice(0, 32))
      expect(copied).toBeLessThan(hidden.length)
    } finally {
      Buffer.concat = originalConcat
    }
  })

  it('leaves a truncated trailing write unparsed until the line completes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-history-partial-'))
    directories.push(directory)
    const path = join(directory, 'session.jsonl')
    await writeFile(path, [
      JSON.stringify({ type: 'message', id: 'u1', parentId: null, message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', message: { role: 'assistant', content: 'yo' } }),
      '{"type":"message","id":"partial"',
    ].join('\n'))
    const page = await new PiSessionHistoryPager(path).loadEarlier(10)
    expect(page.messages.map((message) => message.workbenchEntryId)).toEqual(['u1', 'a1'])
  })

  it('stubs 80 giant tool results and loads a full body by id', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'heddlework-history-budget-'))
    directories.push(directory)
    const path = join(directory, 'session.jsonl')
    const payload = 'y'.repeat(512 * 1024)
    const entries: Array<Record<string, unknown>> = [
      { type: 'session', version: 3, id: 'session', timestamp: '2026-01-01T00:00:00.000Z', cwd: '/tmp' },
    ]
    let parentId: string | null = null
    const append = (id: string, message: Record<string, unknown>) => {
      entries.push({ type: 'message', id, parentId, message })
      parentId = id
    }
    append('u1', { role: 'user', content: 'prompt', timestamp: 1 })
    append('a1', { role: 'assistant', content: 'answer', timestamp: 2 })
    for (let index = 0; index < 80; index += 1) {
      append(`tool-${index}`, { role: 'toolResult', toolCallId: `call-${index}`, toolName: 'read', content: payload, timestamp: 3 + index })
    }
    append('u2', { role: 'user', content: 'follow up', timestamp: 100 })
    append('a2', { role: 'assistant', content: 'done', timestamp: 101 })
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')

    const pager = new PiSessionHistoryPager(path)
    const page = await pager.loadEarlier(82)
    const serialized = JSON.stringify(page)
    expect(serialized.length).toBeLessThan(512 * 1024)
    expect(serialized).not.toContain(payload.slice(0, 32))
    expect(page.messages.at(-2)).toMatchObject({ role: 'user', content: 'follow up', workbenchEntryId: 'u2' })
    expect(page.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'done', workbenchEntryId: 'a2' })
    const stubs = page.messages.filter(isSessionHistoryStub)
    expect(stubs).toHaveLength(80)
    expect(stubs[0]?.workbenchEntryId).toBe('tool-0')
    expect(stubs[0]?.detail.workbenchEntryId).toBe('tool-0')
    const full = await pager.loadEntry('tool-0')
    expect(full).toMatchObject({ role: 'toolResult', toolCallId: 'call-0', toolName: 'read', workbenchEntryId: 'tool-0' })
    expect(typeof full?.content === 'string' ? full.content.length : 0).toBe(payload.length)
    const viaDetail = await pager.loadMessageDetail('tool-79')
    expect(typeof viaDetail?.content === 'string' ? viaDetail.content.length : 0).toBe(payload.length)
  })
})
