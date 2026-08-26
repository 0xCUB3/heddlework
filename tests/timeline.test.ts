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
})
