import type { TimelineItem } from '../../src/workbench/timeline.ts'
import {
  groupWorkItems,
  liveWorkTraceId,
  pendingWorkTraceId,
  projectTranscriptRows,
  serializeProjectionRows,
  workTraceLabel,
  type DisplayTimelineItem,
} from '../../src/ui/transcript-projection.ts'

export interface ProjectionCase {
  name: string
  isStreaming?: boolean
  expanded?: boolean
  timeline: TimelineItem[]
}

export const groupingCases: ProjectionCase[] = [
  {
    name: 'collapsed-work',
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'thinking', kind: 'thinking', text: 'Plan' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'edit', kind: 'tool', tool: { id: 'edit', name: 'edit', args: { path: 'src/a.ts' }, status: 'complete', isError: false } },
      { id: 'answer', kind: 'assistant', text: 'Done' },
    ],
  },
  {
    name: 'live-boundary',
    isStreaming: true,
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'live-thinking', kind: 'thinking', text: 'Planning', streaming: true },
      { id: 'live-tool', kind: 'tool', tool: { id: 'live-tool', name: 'read', status: 'running', isError: false } },
    ],
  },
  {
    name: 'fold-intermediate-assistants',
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'first', kind: 'assistant', text: 'I will inspect the repo.' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'second', kind: 'assistant', text: 'There is a session-switch path.' },
      { id: 'grep', kind: 'tool', tool: { id: 'grep', name: 'grep', status: 'complete', isError: false } },
      { id: 'final', kind: 'assistant', text: 'Here is the answer.' },
    ],
  },
  {
    name: 'compaction-standalone',
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'thinking', kind: 'thinking', text: 'Plan' },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'compact', kind: 'compaction', text: 'Summarized earlier work.', tokensBefore: 150000 },
      { id: 'grep', kind: 'tool', tool: { id: 'grep', name: 'grep', status: 'complete', isError: false } },
      { id: 'answer', kind: 'assistant', text: 'Done' },
    ],
  },
  {
    name: 'notices-grouped',
    expanded: true,
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'thinking', kind: 'thinking', text: 'Plan' },
      { id: 'notice-1', kind: 'notice', notice: { id: 1, kind: 'info', message: 'One', createdAt: 1_000 } },
      { id: 'notice-2', kind: 'notice', notice: { id: 2, kind: 'info', message: 'Two', createdAt: 2_000 } },
      { id: 'notice-3', kind: 'notice', notice: { id: 3, kind: 'info', message: 'Three', createdAt: 8_000 } },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
    ],
  },
  {
    name: 'tool-only',
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
    ],
  },
  {
    name: 'thinking-only',
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'thinking', kind: 'thinking', text: 'Plan' },
      { id: 'answer', kind: 'assistant', text: 'Done' },
    ],
  },
  {
    name: 'error-tool',
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: true } },
      { id: 'answer', kind: 'assistant', text: 'The read failed.' },
    ],
  },
  {
    name: 'abort-status',
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'complete', isError: false } },
      { id: 'abort', kind: 'status', text: 'Interrupted', tone: 'error' },
    ],
  },
  {
    name: 'stream-handoff',
    isStreaming: true,
    timeline: [
      { id: 'user', kind: 'user', text: 'Prompt', images: [] },
      { id: 'thinking', kind: 'thinking', text: 'Plan', streaming: true },
      { id: 'read', kind: 'tool', tool: { id: 'read', name: 'read', status: 'running', isError: false } },
    ],
  },
]

export interface ProjectionSnapshot {
  name: string
  isStreaming: boolean
  groupedKinds: string[]
  groupedIds: string[]
  rowKinds: string[]
  rowIds: string[]
  liveWorkTraceId: string | null
  pendingWorkTraceId: string | null
  labels: string[]
}

export function snapshotCase(entry: ProjectionCase): ProjectionSnapshot {
  const grouped = groupWorkItems(entry.timeline, entry.isStreaming === true)
  const traces = grouped.filter((item): item is Extract<DisplayTimelineItem, { kind: 'work-trace' }> => item.kind === 'work-trace')
  const expanded = entry.expanded ? new Set(traces.map((trace) => trace.id)) : new Set<string>()
  const rows = projectTranscriptRows(grouped, expanded, new Map())
  const rowIds = rows.map((row) => row.id)
  if (new Set(rowIds).size !== rowIds.length) {
    throw new Error(`duplicate projection row ids in ${entry.name}: ${rowIds.join(', ')}`)
  }
  return {
    name: entry.name,
    isStreaming: entry.isStreaming === true,
    groupedKinds: grouped.map((item) => item.kind),
    groupedIds: grouped.map((item) => item.id),
    rowKinds: rows.map((row) => row.kind),
    rowIds: rows.map((row) => row.id),
    liveWorkTraceId: liveWorkTraceId(grouped, entry.isStreaming === true) ?? null,
    pendingWorkTraceId: pendingWorkTraceId(grouped, entry.isStreaming === true) ?? null,
    labels: traces.map((trace) => workTraceLabel(trace, false, true)),
  }
}

export function allProjectionSnapshots(): ProjectionSnapshot[] {
  return groupingCases.map(snapshotCase)
}

export { serializeProjectionRows }
