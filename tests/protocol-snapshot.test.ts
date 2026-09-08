import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin } from '../src/flows/plugin.ts'
import { applySnapshotPatch, diffSnapshots, isPatchEmpty, serializeSnapshot, SNAPSHOT_IMAGE_LIMIT_BYTES } from '../src/protocol/index.ts'
import { createInitialState } from '../src/workbench/state.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

describe('workbench snapshot protocol', () => {
  it('diffs only changed top-level keys and applies patches back', () => {
    const base = serializeSnapshot(createInitialState('/tmp/snap'))
    expect(isPatchEmpty(diffSnapshots(base, base))).toBe(true)
    const next = { ...base, editorText: 'typed', activity: 'Working' }
    const patch = diffSnapshots(base, next)
    expect(Object.keys(patch.changed).sort()).toEqual(['activity', 'editorText'])
    expect(applySnapshotPatch(base, patch)).toEqual(next)
    expect(Object.keys(diffSnapshots(undefined, base).changed).length).toBe(Object.keys(base).length)
  })

  it('preserves serialized collection identity across unrelated state updates', () => {
    const state = createInitialState('/tmp/snap')
    const first = serializeSnapshot(state)
    const next = serializeSnapshot({ ...state, activity: 'Working' })
    const patch = diffSnapshots(first, next)

    expect(next.notices).toBe(first.notices)
    expect(next.editorImages).toBe(first.editorImages)
    expect(Object.keys(patch.changed)).toEqual(['activity'])
  })

  it('sends an older history page as a prepend instead of the whole transcript', () => {
    const base = serializeSnapshot(createInitialState('/tmp/snap'))
    const tail = [{ role: 'user' as const, content: 'first', workbenchEntryId: 'b' }, { role: 'assistant' as const, content: 'second', workbenchEntryId: 'c' }]
    const withTail = { ...base, messages: tail }
    const older = { role: 'user' as const, content: 'older', workbenchEntryId: 'a' }
    const paged = { ...withTail, messages: [older, ...tail], messagesLoadingEarlier: false }
    const patch = diffSnapshots(withTail, paged)
    expect(patch.changed.messages).toBeUndefined()
    expect(patch.messagesPrepend).toEqual([older])
    expect(isPatchEmpty(patch)).toBe(false)
    const wire = JSON.parse(JSON.stringify(patch))
    expect(applySnapshotPatch(withTail, wire).messages).toEqual([older, ...tail])
    const replaced = { ...withTail, messages: [older, { ...tail[0]! }, tail[1]!] }
    expect(diffSnapshots(withTail, replaced).messagesPrepend).toBeUndefined()
    expect(diffSnapshots(withTail, replaced).changed.messages).toEqual(replaced.messages)
  })

  it('round-trips live append ops without sending the whole liveAssistant', () => {
    const base = serializeSnapshot(createInitialState('/tmp/snap'))
    const first = { ...base, liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text' as const, text: 'Hel' }] } }
    const second = { ...first, liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text' as const, text: 'Hello' }] } }
    const patch = diffSnapshots(first, second)
    const wire = JSON.parse(JSON.stringify(patch))
    expect(wire.changed.liveAssistant).toBeUndefined()
    expect(wire.liveOps[0]).toEqual({ op: 'append', target: 'assistant', id: 'live', blockIndex: 0, text: 'lo' })
    expect(applySnapshotPatch(first, wire).liveAssistant?.blocks[0]?.text).toBe('Hello')
  })

  it('clears optional state after a JSON wire roundtrip', () => {
    const base = { ...serializeSnapshot(createInitialState('/tmp/snap')), dialog: { id: 'dialog-1', method: 'confirm' as const, title: 'Continue?', createdAt: 1 } }
    const patch = diffSnapshots(base, { ...base, dialog: undefined })
    const wire = JSON.parse(JSON.stringify(patch))
    expect(wire.removed).toContain('dialog')
    expect(applySnapshotPatch(base, wire).dialog).toBeUndefined()
    expect(isPatchEmpty({ version: 1, changed: {}, removed: ['dialog'] })).toBe(false)
  })

  it('replaces oversized image bytes with a placeholder and keeps small ones', () => {
    const state = createInitialState('/tmp/snap')
    const small = { id: 'a', fileName: 'a.png', size: 10, type: 'image' as const, data: 'AAAA', mimeType: 'image/png' }
    const large = { ...small, id: 'b', size: SNAPSHOT_IMAGE_LIMIT_BYTES + 1, data: 'B'.repeat(8) }
    const snapshot = serializeSnapshot({ ...state, editorImages: [small, large] })
    expect(snapshot.editorImages[0]?.data).toBe('AAAA')
    expect(snapshot.editorImages[1]?.data).toEqual({ omitted: true, bytes: SNAPSHOT_IMAGE_LIMIT_BYTES + 1 })
  })

  it('round-trips a live demo snapshot through JSON', async () => {
    const kernel = new WorkbenchKernel()
    kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-protocol-snapshot'))
    kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
    kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
    kernel.mount(localWorkspaceDiffPlugin)
    kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-protocol-snapshot', demo: true, piArgs: [] }))
    const controller = kernel.get(workbenchControllerToken)
    await controller.start()
    await controller.submit('Produce a transcript for the snapshot test')
    for (let attempt = 0; attempt < 300 && controller.getSnapshot().session.isStreaming; attempt += 1) await Bun.sleep(10)
    const snapshot = serializeSnapshot(controller.getSnapshot())
    const wire = JSON.parse(JSON.stringify(snapshot))
    expect(wire).toEqual(JSON.parse(JSON.stringify(snapshot)))
    expect(wire.messages.length).toBeGreaterThan(0)
    expect(wire.connection).toBe('connected')
    await kernel.dispose()
  }, 10_000)
})
