import { describe, expect, it } from 'bun:test'
import type { TimelineItem } from '../src/workbench/timeline.ts'
import { groupWorkItems, projectTranscriptRows } from '../src/ui/transcript-projection.ts'

describe('transcript projection', () => {
  const items: TimelineItem[] = [
    { id: 'user', kind: 'user', text: 'Prompt', images: [] },
    { id: 'thinking', kind: 'thinking', text: 'Plan' },
    { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
    { id: 'edit', kind: 'tool', tool: { id: 'edit', name: 'edit', args: { path: 'src/a.ts' }, status: 'complete', isError: false } },
    { id: 'answer', kind: 'assistant', text: 'Done' },
  ]

  it('keeps collapsed work as one semantic header plus its changed-files row', () => {
    const grouped = groupWorkItems(items)
    const trace = grouped.find((item) => item.kind === 'work-trace')
    expect(trace).toMatchObject({ id: 'work-trace-edit', kind: 'work-trace', changedPaths: ['src/a.ts'] })

    const rows = projectTranscriptRows(grouped, new Set(), new Map())
    expect(rows.map((row) => row.kind)).toEqual(['timeline-item', 'trace-header', 'trace-files', 'timeline-item'])
  })

  it('keeps a boundary trace ID stable while live work appends', () => {
    const liveThinking: TimelineItem = { id: 'live-thinking', kind: 'thinking', text: 'Planning', streaming: true }
    const liveTool: TimelineItem = { id: 'live-tool', kind: 'tool', tool: { id: 'live-tool', name: 'read', status: 'running', isError: false } }
    const preparing = groupWorkItems([items[0]!, liveThinking])
    const running = groupWorkItems([items[0]!, liveThinking, liveTool])
    expect(preparing.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-after-user')
    expect(running.find((item) => item.kind === 'work-trace')?.id).toBe('work-trace-after-user')
  })

  it('projects only the requested trace prefix and one continuation seam', () => {
    const grouped = groupWorkItems(items)
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    const rows = projectTranscriptRows(grouped, new Set([trace.id]), new Map([[trace.id, 2]]))

    expect(rows.map((row) => row.kind)).toEqual([
      'timeline-item',
      'trace-header',
      'trace-entry',
      'trace-entry',
      'trace-continuation',
      'trace-files',
      'timeline-item',
    ])
    expect(rows.find((row) => row.kind === 'trace-continuation')).toMatchObject({ remaining: 1 })
  })

  it('removes the continuation after every semantic entry is projected', () => {
    const grouped = groupWorkItems(items)
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    const rows = projectTranscriptRows(grouped, new Set([trace.id]), new Map([[trace.id, trace.items.length]]))

    expect(rows.filter((row) => row.kind === 'trace-entry')).toHaveLength(3)
    expect(rows.some((row) => row.kind === 'trace-continuation')).toBe(false)
  })
  it('groups only adjacent notifications emitted close together', () => {
    const notices: TimelineItem[] = [
      { id: 'notice-1', kind: 'notice', notice: { id: 1, kind: 'info', message: 'One', createdAt: 1_000 } },
      { id: 'notice-2', kind: 'notice', notice: { id: 2, kind: 'info', message: 'Two', createdAt: 2_000 } },
      { id: 'notice-3', kind: 'notice', notice: { id: 3, kind: 'info', message: 'Three', createdAt: 8_000 } },
    ]
    const grouped = groupWorkItems([items[0]!, items[1]!, ...notices, items[2]!])
    const trace = grouped.find((item) => item.kind === 'work-trace')!
    const rows = projectTranscriptRows(grouped, new Set([trace.id]), new Map())
    const notificationRows = rows.filter((row) => row.kind === 'trace-notices')

    expect(notificationRows).toHaveLength(2)
    expect(notificationRows.map((row) => row.notices.length)).toEqual([2, 1])
    expect(rows.map((row) => row.kind)).toEqual(['timeline-item', 'trace-header', 'trace-entry', 'trace-notices', 'trace-notices', 'trace-entry'])
  })
})
