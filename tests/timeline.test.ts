import { describe, expect, it } from 'bun:test'
import { buildTimeline } from '../src/workbench/timeline.ts'
import type { PiMessage } from '../src/pi/types.ts'

describe('buildTimeline', () => {
  it('pairs tool results with their assistant tool calls', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'List files', timestamp: 1 },
      {
        role: 'assistant',
        timestamp: 2,
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: 'ls' } },
        ],
      },
      {
        role: 'toolResult',
        timestamp: 3,
        toolCallId: 'call-1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'README.md' }],
        isError: false,
      },
    ]

    const items = buildTimeline(messages, undefined, [])
    expect(items.map((item) => item.kind)).toEqual(['user', 'assistant', 'tool'])
    const tool = items[2]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.tool.args).toEqual({ command: 'ls' })
      expect(tool.tool.output).toBe('README.md')
      expect(tool.tool.status).toBe('complete')
    }
  })

  it('merges live execution state into a replayed tool call', () => {
    const messages: PiMessage[] = [{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'call-2', name: 'read', arguments: { path: 'a.ts' } }],
    }]
    const items = buildTimeline(messages, undefined, [{
      id: 'call-2',
      name: 'read',
      args: { path: 'a.ts' },
      output: 'const value = 1',
      status: 'running',
      isError: false,
    }])
    const tool = items[0]
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') expect(tool.tool.output).toBe('const value = 1')
  })

  it('mirrors Pi by omitting hidden custom messages while retaining displayable ones', () => {
    const items = buildTimeline([
      { role: 'custom', customType: 'hidden-retry', content: 'Retry the previous request.', display: false, timestamp: 1 },
      { role: 'custom', customType: 'visible-status', content: 'Visible extension context', display: true, timestamp: 2 },
    ], undefined, [])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'context-injection', source: 'visible-status', text: 'Visible extension context' })
  })

  it('matches persisted suffix turns by entry ID instead of catalog position', () => {
    const messages: PiMessage[] = [
      { role: 'user', workbenchEntryId: 'tail-user', content: 'Tail prompt', timestamp: 10 },
      { role: 'assistant', workbenchEntryId: 'tail-assistant', content: [{ type: 'thinking', thinking: 'Tail reasoning' }], timestamp: 11 },
    ]
    const items = buildTimeline(messages, undefined, [], [
      { entryId: 'older-user', text: 'Older prompt' },
      { entryId: 'tail-user', text: 'Tail prompt' },
    ])

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ kind: 'user', revertEntryId: 'tail-user' })
    expect(items[1]).toMatchObject({ kind: 'thinking', revertEntryId: 'tail-user' })
  })

  it('attaches image blocks and the nearest forkable prompt to every turn row', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'Inspect this' }, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png', previewPath: '/tmp/image.png' }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'I can see it.' }, { type: 'toolCall', id: 'tool', name: 'read', arguments: { path: 'a.ts' } }], timestamp: 2 },
      { role: 'toolResult', toolCallId: 'tool', toolName: 'read', content: [{ type: 'text', text: 'value' }], timestamp: 3 },
    ]
    const items = buildTimeline(messages, undefined, [], [{ entryId: 'entry-user', text: 'Inspect this' }])
    const user = items.find((item) => item.kind === 'user')
    const assistant = items.find((item) => item.kind === 'assistant')
    const tool = items.find((item) => item.kind === 'tool')
    expect(user).toMatchObject({ kind: 'user', text: 'Inspect this', revertEntryId: 'entry-user' })
    if (user?.kind === 'user') expect(user.images).toHaveLength(1)
    expect(assistant).toMatchObject({ kind: 'assistant', revertEntryId: 'entry-user' })
    expect(tool).toMatchObject({ kind: 'tool', revertEntryId: 'entry-user' })
  })
})
