import { describe, expect, it } from 'bun:test'
import { cycleSessionTreeFilterMode, layoutSessionTreeOptions, sessionTreeFrom, sessionTreeOptions, treeNavigationLeavesBranch } from '../src/pi/session-tree.ts'

const tree = sessionTreeFrom({
  leafId: 'a2',
  tree: [{
    entry: { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Start here' } },
    children: [{
      entry: { type: 'message', id: 'answer', parentId: 'root', message: { role: 'assistant', content: 'Choose a path' } },
      children: [
        {
          entry: { type: 'message', id: 'a1', parentId: 'answer', message: { role: 'user', content: 'Path A' } },
          children: [{ entry: { type: 'message', id: 'a2', parentId: 'a1', message: { role: 'assistant', content: 'On A' } }, children: [] }],
        },
        {
          entry: { type: 'message', id: 'b1', parentId: 'answer', message: { role: 'user', content: 'Path B' } },
          children: [{ entry: { type: 'message', id: 'b2', parentId: 'b1', message: { role: 'assistant', content: 'On B' } }, children: [], label: 'alternative' }],
        },
      ],
    }],
  }],
})!

describe('Pi session tree', () => {
  it('compresses linear history and emits connected branch guides with the active path last', () => {
    const options = sessionTreeOptions(tree)
    expect(options.map((option) => option.entryId)).toEqual(['root', 'answer', 'a1', 'a2', 'b1', 'b2'])
    expect(options.find((option) => option.entryId === 'root')).toMatchObject({ title: 'user', detail: 'Start here' })
    expect(options.find((option) => option.entryId === 'a2')).toMatchObject({ title: 'assistant', detail: 'On A', active: true, onActivePath: true })
    expect(options.find((option) => option.entryId === 'b2')).toMatchObject({ label: 'alternative', active: false, onActivePath: false })

    const rows = layoutSessionTreeOptions(options)
    expect(rows.map((row) => row.entryId)).toEqual(['root', 'answer', 'b1', 'b2', 'a1', 'a2'])
    expect(rows.map(({ entryId, depth, connection, guides }) => ({ entryId, depth, connection, guides }))).toEqual([
      { entryId: 'root', depth: 0, connection: 'root', guides: [] },
      { entryId: 'answer', depth: 0, connection: 'chain', guides: [] },
      { entryId: 'b1', depth: 1, connection: 'branch', guides: [0] },
      { entryId: 'b2', depth: 1, connection: 'chain', guides: [0] },
      { entryId: 'a1', depth: 1, connection: 'branch', guides: [] },
      { entryId: 'a2', depth: 1, connection: 'chain', guides: [] },
    ])
    expect(rows.at(-1)).toMatchObject({ entryId: 'a2', active: true })
  })

  it('reattaches filtered matches without retaining hidden per-message depth', () => {
    const rows = layoutSessionTreeOptions(sessionTreeOptions(tree), 'path b')
    expect(rows.map(({ entryId, depth, connection }) => ({ entryId, depth, connection }))).toEqual([
      { entryId: 'b1', depth: 0, connection: 'root' },
    ])
  })


  it('matches Pi core views and adds assistant-only to the projection cycle', () => {
    const richTree = sessionTreeFrom({
      leafId: 'final',
      tree: [{
        entry: { type: 'message', id: 'root', parentId: null, message: { role: 'user', content: 'Start' } },
        label: 'checkpoint',
        labelTimestamp: '2026-08-30T10:15:00.000Z',
        children: [{
          entry: { type: 'message', id: 'tool-call-only', parentId: 'root', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'call-1', name: 'read', arguments: {} }], stopReason: 'toolUse' } },
          children: [{
            entry: { type: 'message', id: 'tool', parentId: 'tool-call-only', message: { role: 'toolResult', toolName: 'read', content: 'file contents' } },
            children: [{
              entry: { type: 'model_change', id: 'model', parentId: 'tool', modelId: 'opus' },
              children: [{
                entry: { type: 'thinking_level_change', id: 'thinking', parentId: 'model', thinkingLevel: 'high' },
                children: [{
                  entry: { type: 'custom', id: 'custom', parentId: 'thinking', customType: 'tps' },
                  children: [{
                    entry: { type: 'label', id: 'label', parentId: 'custom', targetId: 'root', label: 'checkpoint' },
                    children: [{
                      entry: { type: 'session_info', id: 'title', parentId: 'label', name: 'Project' },
                      children: [{ entry: { type: 'message', id: 'final', parentId: 'title', message: { role: 'assistant', content: 'Done' } }, children: [] }],
                    }],
                  }],
                }],
              }],
            }],
          }],
        }],
      }],
    })!
    const options = sessionTreeOptions(richTree)
    expect(options.map((option) => option.entryId)).toEqual(['root', 'tool', 'model', 'thinking', 'custom', 'label', 'title', 'final'])
    expect(options[0]).toMatchObject({ label: 'checkpoint', labelTimestamp: '2026-08-30T10:15:00.000Z', kind: 'user' })
    expect(layoutSessionTreeOptions(options).map((row) => row.entryId)).toEqual(['root', 'tool', 'final'])
    expect(layoutSessionTreeOptions(options, '', 'no-tools').map((row) => row.entryId)).toEqual(['root', 'final'])
    expect(layoutSessionTreeOptions(options, '', 'user-only').map((row) => row.entryId)).toEqual(['root'])
    expect(layoutSessionTreeOptions(options, '', 'assistant-only').map((row) => row.entryId)).toEqual(['final'])
    expect(layoutSessionTreeOptions(options, '', 'labeled-only').map((row) => row.entryId)).toEqual(['root'])
    expect(layoutSessionTreeOptions(options, '', 'all').map((row) => row.entryId)).toEqual(['root', 'tool', 'model', 'thinking', 'custom', 'label', 'title', 'final'])
    expect(layoutSessionTreeOptions(options, 'model opus', 'all').map((row) => row.entryId)).toEqual(['model'])

    expect(cycleSessionTreeFilterMode('default', 1)).toBe('no-tools')
    expect(cycleSessionTreeFilterMode('user-only', 1)).toBe('assistant-only')
    expect(cycleSessionTreeFilterMode('assistant-only', 1)).toBe('labeled-only')
    expect(cycleSessionTreeFilterMode('default', -1)).toBe('all')
  })

  it('projects a ten-thousand-entry linear session iteratively at one visual depth', () => {
    let nested: Record<string, unknown> | undefined
    for (let index = 9_999; index >= 0; index -= 1) {
      nested = {
        entry: { type: 'message', id: `entry-${index}`, parentId: index === 0 ? null : `entry-${index - 1}`, message: { role: index % 2 === 0 ? 'user' : 'assistant', content: `Message ${index}` } },
        children: nested ? [nested] : [],
      }
    }
    const largeTree = sessionTreeFrom({ tree: [nested], leafId: 'entry-9999' })!
    const rows = layoutSessionTreeOptions(sessionTreeOptions(largeTree))
    expect(rows).toHaveLength(10_000)
    expect(rows.every((row) => row.depth === 0)).toBe(true)
    expect(rows.at(-1)).toMatchObject({ entryId: 'entry-9999', active: true })
  })

  it('only offers branch summarization when navigation abandons active entries', () => {
    expect(treeNavigationLeavesBranch(tree, 'answer')).toBe(true)
    expect(treeNavigationLeavesBranch(tree, 'b2')).toBe(true)
    expect(treeNavigationLeavesBranch(tree, 'a2')).toBe(false)
  })

  it('rejects malformed tree responses', () => {
    expect(sessionTreeFrom({ tree: [], leafId: undefined })).toBeUndefined()
    expect(sessionTreeFrom({ tree: [{ entry: { type: 'message' }, children: [] }], leafId: null })).toEqual({ tree: [], leafId: null })
  })
})
