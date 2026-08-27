import type { TimelineItem } from '../workbench/timeline.ts'

export type TraceTimelineItem = Extract<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' }>

export type DisplayTimelineItem = Exclude<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' }> | {
  id: string
  kind: 'work-trace'
  items: TraceTimelineItem[]
  changedPaths: string[]
  identity: 'boundary' | 'terminal'
  boundaryId?: string
  revertEntryId?: string
}

export type TranscriptProjectionRow =
  | { id: string; kind: 'timeline-item'; item: Exclude<DisplayTimelineItem, { kind: 'work-trace' }> }
  | { id: string; kind: 'trace-header'; trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }> }
  | { id: string; kind: 'trace-entry'; traceId: string; item: TraceTimelineItem }
  | { id: string; kind: 'trace-files'; traceId: string; paths: string[] }
  | { id: string; kind: 'trace-continuation'; traceId: string; remaining: number }

export function groupWorkItems(items: TimelineItem[]): DisplayTimelineItem[] {
  const grouped: DisplayTimelineItem[] = []
  let boundaryId: string | undefined
  for (const item of items) {
    if (item.kind !== 'thinking' && item.kind !== 'context-injection' && item.kind !== 'tool') {
      grouped.push(item)
      boundaryId = item.id
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'work-trace') {
      previous.items.push(item)
      previous.id = `work-trace-${item.id}`
      if (item.revertEntryId) previous.revertEntryId = item.revertEntryId
      const path = changedPath(item)
      if (path && !previous.changedPaths.includes(path)) previous.changedPaths.push(path)
    } else {
      const path = changedPath(item)
      grouped.push({
        id: `work-trace-${item.id}`,
        kind: 'work-trace',
        items: [item],
        changedPaths: path ? [path] : [],
        identity: 'terminal',
        ...(boundaryId ? { boundaryId } : {}),
        ...(item.revertEntryId ? { revertEntryId: item.revertEntryId } : {}),
      })
    }
  }
  for (const item of grouped) {
    if (item.kind !== 'work-trace' || !item.boundaryId) continue
    const active = item.items.some((entry) => entry.kind === 'thinking' ? entry.streaming : entry.kind === 'tool' ? entry.tool.status !== 'complete' : false)
    if (!active) continue
    item.id = `work-trace-after-${item.boundaryId}`
    item.identity = 'boundary'
  }
  return grouped
}

export function projectTranscriptRows(items: DisplayTimelineItem[], expandedTraceIds: ReadonlySet<string>, traceLimits: ReadonlyMap<string, number>): TranscriptProjectionRow[] {
  const rows: TranscriptProjectionRow[] = []
  for (const item of items) {
    if (item.kind !== 'work-trace') {
      rows.push({ id: item.id, kind: 'timeline-item', item })
      continue
    }
    rows.push({ id: item.id, kind: 'trace-header', trace: item })
    if (expandedTraceIds.has(item.id)) {
      const limit = Math.min(item.items.length, Math.max(0, traceLimits.get(item.id) ?? item.items.length))
      for (const entry of item.items.slice(0, limit)) rows.push({ id: `${item.id}:entry:${entry.id}`, kind: 'trace-entry', traceId: item.id, item: entry })
      if (limit < item.items.length) rows.push({ id: `${item.id}:continuation`, kind: 'trace-continuation', traceId: item.id, remaining: item.items.length - limit })
    }
    if (item.changedPaths.length > 0) rows.push({ id: `${item.id}:files`, kind: 'trace-files', traceId: item.id, paths: item.changedPaths })
  }
  return rows
}

function changedPath(item: TraceTimelineItem): string | undefined {
  if (item.kind !== 'tool' || (item.tool.name !== 'edit' && item.tool.name !== 'write')) return undefined
  const args = item.tool.args && typeof item.tool.args === 'object' ? item.tool.args as Record<string, unknown> : {}
  return typeof args.path === 'string' ? args.path : undefined
}
