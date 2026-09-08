import { describe, expect, it } from 'bun:test'
import type { PiMessage } from '../src/pi/types.ts'
import {
  applySnapshotPatch,
  clampTranscriptDetailLimit,
  diffSnapshots,
  findTranscriptDetail,
  mergeTranscriptDetail,
  pageTranscriptDetail,
  projectLiveAssistant,
  projectLiveTools,
  projectWorkbenchSnapshot,
  serializeSnapshot,
  TranscriptExpansionCache,
  TRANSCRIPT_DETAIL_PAGE_BYTES,
  TRANSCRIPT_RESERVED_TAIL_BYTES,
  TRANSCRIPT_WIRE_BUDGET_BYTES,
} from '../src/protocol/index.ts'
import { createInitialState } from '../src/workbench/state.ts'

function assemble(source: Parameters<typeof pageTranscriptDetail>[0], limit = 64) {
  const cache = new TranscriptExpansionCache()
  let offset = 0
  let last = pageTranscriptDetail(source, { offset, limit, sessionFile: '/tmp/s.jsonl', requestId: 'r1' })
  let snapshot = serializeSnapshot({ ...createInitialState('/tmp'), messages: source.kind === 'message' ? [source.message] : [], liveTools: source.kind === 'tool' ? [source.tool] : [], liveAssistant: source.kind === 'liveAssistant' ? source.assistant : undefined })
  for (let page = 0; page < 512; page += 1) {
    snapshot = mergeTranscriptDetail(snapshot, last, cache)
    if (last.complete) return { detail: last, snapshot, cache }
    expect(last.bytes).toBeGreaterThan(0)
    offset = last.offset + last.bytes
    last = pageTranscriptDetail(source, { offset, limit, sessionFile: '/tmp/s.jsonl', requestId: 'r1' })
  }
  throw new Error('did not complete')
}

describe('typed transcript detail pages', () => {
  it('recovers mixed image+text and tool args without flattening', () => {
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const message: PiMessage = {
      role: 'user',
      workbenchEntryId: 'img-1',
      content: [
        { type: 'text', text: 'see this 中文 🎯' },
        { type: 'image', data: image, mimeType: 'image/png' },
      ],
      timestamp: 1,
    }
    const { snapshot } = assemble({ kind: 'message', entryId: 'img-1', message }, 17)
    expect(snapshot.messages[0]?.content).toEqual(message.content)
    expect(snapshot.messages[0]?.detailRef).toBeUndefined()
  })

  it('recovers tool args, details, and output', () => {
    const tool = {
      id: 'bash-1',
      name: 'bash',
      status: 'complete' as const,
      isError: false,
      args: { cmd: 'echo 🎯' },
      details: { cwd: '/tmp' },
      output: 'hello 中文',
    }
    const { snapshot } = assemble({ kind: 'tool', entryId: 'bash-1', tool }, 11)
    expect(snapshot.liveTools[0]).toMatchObject({ args: tool.args, details: tool.details, output: tool.output })
  })

  it('pages a body larger than 32 MiB and clamps command pages', () => {
    const giant: PiMessage = {
      role: 'toolResult',
      workbenchEntryId: 'huge',
      content: 'x'.repeat(32 * 1024 * 1024 + 2048),
      timestamp: 1,
    }
    expect(clampTranscriptDetailLimit(100_000_000)).toBe(TRANSCRIPT_DETAIL_PAGE_BYTES)
    const first = pageTranscriptDetail({ kind: 'message', entryId: 'huge', message: giant }, { offset: 0, limit: 100_000_000 })
    expect(first.bytes).toBeLessThanOrEqual(TRANSCRIPT_DETAIL_PAGE_BYTES)
    expect(first.message).toBeUndefined()
    expect(first.encoding).toBe('json')
    const { snapshot } = assemble({ kind: 'message', entryId: 'huge', message: giant }, TRANSCRIPT_DETAIL_PAGE_BYTES)
    expect(snapshot.messages[0]?.content).toHaveLength((giant.content as string).length)
  }, 120_000)

  it('makes progress on a tiny limit at a unicode boundary and ignores duplicate pages', () => {
    const message: PiMessage = { role: 'assistant', workbenchEntryId: 'u', content: '🎯🎯🎯', timestamp: 1 }
    const first = pageTranscriptDetail({ kind: 'message', entryId: 'u', message }, { offset: 0, limit: 1 })
    expect(first.bytes).toBeGreaterThan(0)
    expect(first.complete).toBe(false)
    const cache = new TranscriptExpansionCache()
    let snapshot = serializeSnapshot({ ...createInitialState('/tmp'), messages: [message] })
    snapshot = mergeTranscriptDetail(snapshot, first, cache)
    snapshot = mergeTranscriptDetail(snapshot, first, cache)
    const second = pageTranscriptDetail({ kind: 'message', entryId: 'u', message }, { offset: first.bytes, limit: 1, requestId: 'r' })
    snapshot = mergeTranscriptDetail(snapshot, second, cache)
    expect(snapshot.messages[0]?.content === '🎯🎯🎯' || snapshot.messages[0]?.detailRef).toBeTruthy()
  })

  it('drops an in-flight assembly when the session switches', () => {
    const message: PiMessage = { role: 'assistant', workbenchEntryId: 'u', content: 'abcdefghij'.repeat(20), timestamp: 1 }
    const cache = new TranscriptExpansionCache()
    const stub: PiMessage = { role: 'assistant', workbenchEntryId: 'u', content: 'ab…', detailRef: { entryId: 'u', bytes: 200, omitted: true }, timestamp: 1 }
    const first = pageTranscriptDetail({ kind: 'message', entryId: 'u', message }, { offset: 0, limit: 8, sessionFile: '/tmp/a.jsonl' })
    let snapshot = serializeSnapshot({ ...createInitialState('/tmp'), messages: [stub] })
    snapshot = mergeTranscriptDetail(snapshot, first, cache)
    cache.switchSession()
    const other = pageTranscriptDetail({ kind: 'message', entryId: 'u', message }, { offset: first.bytes, limit: 8, sessionFile: '/tmp/b.jsonl' })
    const after = mergeTranscriptDetail(snapshot, other, cache)
    expect(after.messages[0]?.content).toBe('ab…')
  })

  it('keeps an expanded message across a later stubbed snapshot', () => {
    const original: PiMessage = { role: 'assistant', workbenchEntryId: 'keep', content: 'Q'.repeat(20_000), timestamp: 1 }
    const { snapshot, cache } = assemble({ kind: 'message', entryId: 'keep', message: original }, 128)
    expect(snapshot.messages[0]?.content).toBe(original.content)
    const stubbed = projectWorkbenchSnapshot(serializeSnapshot({
      ...createInitialState('/tmp/s.jsonl'),
      session: { ...createInitialState('/tmp/s.jsonl').session, sessionFile: '/tmp/s.jsonl' },
      messages: [original],
    }), { bodyBudget: 32, wireBudget: 1024 })
    const overlaid = cache.overlay({ ...stubbed, session: { ...stubbed.session, sessionFile: '/tmp/s.jsonl' } })
    expect(overlaid.messages[0]?.content).toBe(original.content)
    expect(overlaid.messages[0]?.detailRef).toBeUndefined()
  })
})

describe('projected live bodies', () => {
  it('adds recoverable detailRef instead of silently dropping live tails', () => {
    const assistant = { id: 'live', blocks: [{ index: 0, kind: 'text' as const, text: 'a'.repeat(TRANSCRIPT_RESERVED_TAIL_BYTES + 4096) }] }
    const projected = projectLiveAssistant(assistant)!
    expect(projected.blocks[0]?.detailRef).toMatchObject({ omitted: true, entryId: 'live#0' })
    expect(utf8Tail(projected.blocks[0]!.text).length).toBeLessThan(assistant.blocks[0]!.text.length)
    const found = findTranscriptDetail({ liveAssistant: assistant }, 'live#0')
    expect(found?.kind).toBe('liveAssistant')
    const tools = projectLiveTools([{ id: 't', name: 'read', status: 'running', isError: false, args: { file: 'x'.repeat(20_000) }, output: 'o'.repeat(20_000) }])
    expect(tools[0]?.detailRef).toMatchObject({ omitted: true, entryId: 't' })
    expect(tools[0]?.args).toBeUndefined()
  })

  it('diffs projected live windows with trim+append instead of replacing the tail', () => {
    const state = createInitialState('/tmp/live')
    let previous = projectWorkbenchSnapshot(serializeSnapshot({
      ...state,
      liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'x'.repeat(TRANSCRIPT_RESERVED_TAIL_BYTES) }] },
    }))
    let applied = previous
    let total = 0
    for (let index = 1; index <= 16; index += 1) {
      const full = serializeSnapshot({
        ...state,
        liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'x'.repeat(TRANSCRIPT_RESERVED_TAIL_BYTES + index * 1024) }] },
      })
      const next = projectWorkbenchSnapshot(full)
      const patch = diffSnapshots(previous, next)
      expect(patch.changed.liveAssistant).toBeUndefined()
      expect(patch.liveOps?.some((op) => op.op === 'append')).toBe(true)
      applied = applySnapshotPatch(applied, patch)
      total += JSON.stringify({ kind: 'patch', patch }).length
      previous = next
    }
    expect(total).toBeLessThan(16 * 1024 * 8)
    const recovered = findTranscriptDetail({
      liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'x'.repeat(TRANSCRIPT_RESERVED_TAIL_BYTES + 16 * 1024) }] },
    }, 'live')
    expect(recovered?.kind).toBe('liveAssistant')
  })

  it('looks up a toolResult by toolCallId and merges onto that stub', () => {
    const original: PiMessage = {
      role: 'toolResult',
      workbenchEntryId: 'hist-9',
      toolCallId: 'call-9',
      toolName: 'bash',
      content: 'full tool output '.repeat(40),
      timestamp: 2,
    }
    const found = findTranscriptDetail({ messages: [original] }, 'call-9')
    expect(found?.kind).toBe('message')
    expect(found?.entryId).toBe('hist-9')
    const stub: PiMessage = {
      role: 'toolResult',
      workbenchEntryId: 'hist-9',
      toolCallId: 'call-9',
      toolName: 'bash',
      content: 'full tool output…',
      timestamp: 2,
      detailRef: { entryId: 'hist-9', bytes: 800, omitted: true },
    }
    const page = pageTranscriptDetail(found!, { offset: 0, sessionFile: '/tmp/s.jsonl' })
    const snapshot = mergeTranscriptDetail(serializeSnapshot({
      ...createInitialState('/tmp/s.jsonl'),
      session: { ...createInitialState('/tmp/s.jsonl').session, sessionFile: '/tmp/s.jsonl' },
      messages: [stub],
    }), page)
    expect(snapshot.messages[0]?.content).toBe(original.content)
    expect(snapshot.messages[0]?.detailRef).toBeUndefined()
  })

  it('keeps a projected snapshot under the 1.5 MiB wire budget with many live tools', () => {
    const state = createInitialState('/tmp/live')
    const liveTools = Array.from({ length: 400 }, (_, index) => ({
      id: 't' + index,
      name: 'read',
      status: 'complete' as const,
      isError: false,
      output: 'o'.repeat(32 * 1024),
    }))
    const snapshot = projectWorkbenchSnapshot(serializeSnapshot({ ...state, liveTools }))
    const bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8')
    expect(bytes).toBeLessThan(TRANSCRIPT_WIRE_BUDGET_BYTES)
    expect(snapshot.liveTools[0]?.detailRef?.omitted).toBe(true)
  })
})

function utf8Tail(text: string): string {
  return text
}
