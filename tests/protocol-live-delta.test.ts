import { describe, expect, it } from 'bun:test'
import {
  applySnapshotPatch,
  diffSnapshots,
  serializeSnapshot,
  snapshotNeedsLiveResync,
} from '../src/protocol/index.ts'
import { createInitialState } from '../src/workbench/state.ts'

describe('incremental live content', () => {
  it('encodes append-only assistant text instead of replacing the whole liveAssistant', () => {
    const state = createInitialState('/tmp/live')
    let previous = serializeSnapshot(state)
    let total = 0
    for (let index = 1; index <= 200; index += 1) {
      const next = serializeSnapshot({
        ...state,
        session: { ...state.session, isStreaming: true },
        liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'x'.repeat(index * 1024) }] },
      })
      const patch = diffSnapshots(previous, next)
      if (index > 1) {
        expect(patch.changed.liveAssistant).toBeUndefined()
        expect(patch.liveOps).toEqual([{ op: 'append', target: 'assistant', id: 'live', blockIndex: 0, text: 'x'.repeat(1024) }])
        const applied = applySnapshotPatch(previous, patch)
        expect(applied.liveAssistant?.blocks[0]?.text).toBe('x'.repeat(index * 1024))
      }
      total += JSON.stringify({ kind: 'patch', patch }).length
      previous = next
    }
    const newText = 200 * 1024
    expect(total).toBeLessThan(newText * 8)
    expect(total / newText).toBeLessThan(10)
  })

  it('resyncs live assistant when identity changes, and clients detect sequence gaps', () => {
    const state = createInitialState('/tmp/live')
    const first = serializeSnapshot({
      ...state,
      liveAssistant: { id: 'live-a', blocks: [{ index: 0, kind: 'text', text: 'hello' }] },
    })
    const branched = serializeSnapshot({
      ...state,
      liveAssistant: { id: 'live-b', blocks: [{ index: 0, kind: 'text', text: 'other' }] },
    })
    const patch = diffSnapshots(first, branched)
    expect(patch.liveOps).toBeUndefined()
    expect(patch.changed.liveAssistant?.id).toBe('live-b')
    expect(applySnapshotPatch(first, patch).liveAssistant?.id).toBe('live-b')

    const tombstone = diffSnapshots(first, serializeSnapshot({ ...state, liveAssistant: undefined }))
    expect(tombstone.removed).toContain('liveAssistant')
    expect(applySnapshotPatch(first, tombstone).liveAssistant).toBeUndefined()

    expect(snapshotNeedsLiveResync(4, { version: 1, changed: {}, liveOps: [{ op: 'append', target: 'assistant', id: 'live', blockIndex: 0, text: 'x' }], seq: 7 })).toBe(true)
    expect(snapshotNeedsLiveResync(4, { version: 1, changed: {}, liveOps: [{ op: 'append', target: 'assistant', id: 'live', blockIndex: 0, text: 'x' }], seq: 5 })).toBe(false)
    expect(snapshotNeedsLiveResync(4, { version: 1, changed: { liveAssistant: first.liveAssistant }, seq: 9 })).toBe(false)
  })

  it('keeps assistant appends when a simultaneous tool start resyncs liveTools', () => {
    const state = createInitialState('/tmp/live')
    const previous = serializeSnapshot({
      ...state,
      liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'hello' }] },
      liveTools: [],
    })
    const next = serializeSnapshot({
      ...state,
      liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'hello world' }] },
      liveTools: [{ id: 't', name: 'bash', status: 'running', isError: false, output: '' }],
    })
    const patch = diffSnapshots(previous, next)
    expect(patch.changed.liveAssistant).toBeUndefined()
    expect(patch.changed.liveTools).toEqual(next.liveTools)
    expect(patch.liveOps).toEqual([{ op: 'append', target: 'assistant', id: 'live', blockIndex: 0, text: ' world' }])
    const applied = applySnapshotPatch(previous, patch)
    expect(applied.liveAssistant?.blocks[0]?.text).toBe('hello world')
    expect(applied.liveTools[0]?.id).toBe('t')
  })

  it('appends tool output without replacing the whole liveTools array', () => {
    const state = createInitialState('/tmp/live')
    const previous = serializeSnapshot({
      ...state,
      liveTools: [{ id: 't', name: 'read', status: 'running', isError: false, output: 'abc' }],
    })
    const next = serializeSnapshot({
      ...state,
      liveTools: [{ id: 't', name: 'read', status: 'running', isError: false, output: 'abcdef' }],
    })
    const patch = diffSnapshots(previous, next)
    expect(patch.changed.liveTools).toBeUndefined()
    expect(patch.liveOps).toEqual([{ op: 'append', target: 'tool', id: 't', text: 'def' }])
    expect(applySnapshotPatch(previous, patch).liveTools[0]?.output).toBe('abcdef')
  })
})
