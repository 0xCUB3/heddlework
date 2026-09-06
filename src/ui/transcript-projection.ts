import type { TimelineItem } from '../workbench/timeline.ts'
import { formatElapsedSeconds } from './duration.ts'

export type TraceTimelineItem = Extract<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' | 'notice' | 'assistant' | 'compaction' }>

export type DisplayTimelineItem = Exclude<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' | 'notice' | 'compaction' }> | {
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
  | { id: string; kind: 'trace-entry'; traceId: string; item: Exclude<TraceTimelineItem, { kind: 'notice' }> }
  | { id: string; kind: 'trace-notices'; traceId: string; notices: Array<Extract<TraceTimelineItem, { kind: 'notice' }>> }
  | { id: string; kind: 'trace-files'; traceId: string; paths: string[] }
  | { id: string; kind: 'trace-continuation'; traceId: string; remaining: number }

export function isActiveTraceEntry(item: TraceTimelineItem): boolean {
  return item.kind === 'thinking' ? Boolean(item.streaming) : item.kind === 'tool' ? item.tool.status !== 'complete' : false
}

export function isCompactionWorkTrace(item: DisplayTimelineItem): boolean {
  return item.kind === 'work-trace'
    && item.items.some((entry) => entry.kind === 'compaction')
    && item.items.every((entry) => entry.kind === 'compaction' || entry.kind === 'notice')
}

export function groupWorkItems(items: TimelineItem[], isStreaming = false): DisplayTimelineItem[] {
  const absorbedAssistants = intermediateAssistantIds(items)
  const grouped: DisplayTimelineItem[] = []
  let boundaryId: string | undefined
  for (const item of items) {
    // Turn metrics may be persisted after the final answer. Keep them with that turn's work.
    if (item.kind === 'context-injection' && item.source === 'turn metrics') {
      let attached = false
      for (let index = grouped.length - 1; index >= 0; index--) {
        const candidate = grouped[index]!
        if (candidate.kind === 'user') break
        if (candidate.kind === 'work-trace' && !isCompactionWorkTrace(candidate)) {
          candidate.items.push(item)
          attached = true
          break
        }
      }
      if (attached) continue
    }
    if (item.kind === 'compaction') {
      grouped.push({
        id: `work-trace-${item.id}`,
        kind: 'work-trace',
        items: [item],
        changedPaths: [],
        identity: 'terminal',
        ...(item.revertEntryId ? { revertEntryId: item.revertEntryId } : {}),
      })
      continue
    }
    if (!isTraceItem(item, absorbedAssistants)) {
      grouped.push(item)
      boundaryId = item.id
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'work-trace' && previous.items.every((entry) => entry.kind !== 'compaction')) {
      previous.items.push(item)
      if (item.kind !== 'notice') previous.id = `work-trace-${item.id}`
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
  let lastUser = -1
  for (let index = 0; index < grouped.length; index += 1) {
    if (grouped[index]!.kind === 'user') lastUser = index
  }
  for (let index = 0; index < grouped.length; index += 1) {
    const item = grouped[index]!
    if (item.kind !== 'work-trace' || !item.boundaryId || item.items.some((entry) => entry.kind === 'compaction')) continue
    const currentTurn = index > lastUser && grouped.slice(index + 1).every((next) => next.kind !== 'user' && !(next.kind === 'assistant' && !next.streaming))
    if (!item.items.some(isActiveTraceEntry) && !(isStreaming && currentTurn)) continue
    item.id = `work-trace-after-${item.boundaryId}`
    item.identity = 'boundary'
  }
  return grouped
}

export function pendingWorkTraceId(items: readonly DisplayTimelineItem[], isStreaming: boolean): string | undefined {
  if (!isStreaming || liveWorkTraceId(items, isStreaming)) return undefined
  let lastUser = -1
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.kind === 'user') lastUser = index
  }
  if (lastUser < 0) return undefined
  for (let index = lastUser + 1; index < items.length; index += 1) {
    const item = items[index]!
    if (item.kind === 'assistant' || item.kind === 'work-trace') return undefined
  }
  return `work-trace-after-${items[lastUser]!.id}`
}

export function emptyWorkTrace(id: string): Extract<DisplayTimelineItem, { kind: 'work-trace' }> {
  const boundaryId = id.startsWith('work-trace-after-') ? id.slice('work-trace-after-'.length) : id
  return { id, kind: 'work-trace', items: [], changedPaths: [], identity: 'boundary', boundaryId }
}

export function liveWorkTraceId(items: readonly DisplayTimelineItem[], isStreaming: boolean): string | undefined {
  let lastUser = -1
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.kind === 'user') lastUser = index
  }
  for (let index = items.length - 1; index > lastUser; index -= 1) {
    const item = items[index]!
    if (item.kind === 'assistant') return undefined
    if (item.kind !== 'work-trace') continue
    if (isCompactionWorkTrace(item)) return undefined
    if (isStreaming) return item.id
    return undefined
  }
  return undefined
}

export function currentWorkWave(items: readonly TraceTimelineItem[]): {
  tools: Array<Extract<TraceTimelineItem, { kind: 'tool' }>>
  preview: TraceTimelineItem | undefined
} {
  let start = 0
  for (let index = 0; index < items.length; index += 1) {
    if (items[index]!.kind === 'assistant') start = index + 1
  }
  const wave = items.slice(start)
  return {
    tools: wave.filter((item): item is Extract<TraceTimelineItem, { kind: 'tool' }> => item.kind === 'tool'),
    preview: wave.at(-1),
  }
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
      const entries = item.items.slice(0, limit)
      for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index]!
        if (entry.kind !== 'notice') {
          rows.push({ id: `${item.id}:entry:${entry.id}`, kind: 'trace-entry', traceId: item.id, item: entry })
          continue
        }
        const notices = [entry]
        while (entries[index + 1]?.kind === 'notice') {
          const next = entries[index + 1] as Extract<TraceTimelineItem, { kind: 'notice' }>
          const previous = notices.at(-1)!
          if (next.notice.createdAt - previous.notice.createdAt > 5_000) break
          notices.push(next)
          index += 1
        }
        rows.push({ id: `${item.id}:notices:${notices[0]!.id}`, kind: 'trace-notices', traceId: item.id, notices })
      }
      if (limit < item.items.length) rows.push({ id: `${item.id}:continuation`, kind: 'trace-continuation', traceId: item.id, remaining: item.items.length - limit })
    }
    if (item.changedPaths.length > 0) rows.push({ id: `${item.id}:files`, traceId: item.id, kind: 'trace-files', paths: item.changedPaths })
  }
  return rows
}

function isTraceItem(item: TimelineItem, absorbedAssistants: ReadonlySet<string>): item is TraceTimelineItem {
  if (item.kind === 'thinking' || item.kind === 'context-injection' || item.kind === 'tool' || item.kind === 'notice' || item.kind === 'compaction') return true
  return item.kind === 'assistant' && absorbedAssistants.has(item.id)
}

function intermediateAssistantIds(items: readonly TimelineItem[]): ReadonlySet<string> {
  const ids = new Set<string>()
  let pending: string[] = []
  const absorbPending = () => {
    for (const id of pending) ids.add(id)
    pending = []
  }
  for (const item of items) {
    if (item.kind === 'user') {
      pending = []
      continue
    }
    if (item.kind === 'assistant') {
      pending.push(item.id)
      continue
    }
    if (item.kind === 'tool') absorbPending()
  }
  return ids
}

function changedPath(item: TraceTimelineItem): string | undefined {
  if (item.kind !== 'tool' || (item.tool.name !== 'edit' && item.tool.name !== 'write')) return undefined
  const args = item.tool.args && typeof item.tool.args === 'object' ? item.tool.args as Record<string, unknown> : {}
  return typeof args.path === 'string' ? args.path : undefined
}

export function traceDuration(items: Array<Pick<TimelineItem, 'timestamp'>>): string | undefined {
  let earliest = Number.POSITIVE_INFINITY
  let latest = Number.NEGATIVE_INFINITY
  let timestampCount = 0
  for (const item of items) {
    if (typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp)) continue
    earliest = Math.min(earliest, item.timestamp)
    latest = Math.max(latest, item.timestamp)
    timestampCount += 1
  }
  return timestampCount > 1 ? formatElapsedSeconds((latest - earliest) / 1_000) : undefined
}

export function compactionTraceLabel(trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }>): string | undefined {
  if (!isCompactionWorkTrace(trace)) return undefined
  const compaction = trace.items.find((item): item is Extract<TraceTimelineItem, { kind: 'compaction' }> => item.kind === 'compaction')
  if (!compaction) return undefined
  return typeof compaction.tokensBefore === 'number' ? `Compacted from ${compaction.tokensBefore.toLocaleString('en-US')} tokens` : 'Compacted'
}

export function workTraceLabel(
  trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }>,
  running: boolean,
  durationKnown: boolean,
): string {
  if (running) return 'Working'
  const compaction = compactionTraceLabel(trace)
  if (compaction) return compaction
  const duration = durationKnown ? traceDuration(trace.items) : undefined
  return duration ? `Worked for ${duration}` : 'Worked'
}

export function serializeProjectionRows(rows: readonly TranscriptProjectionRow[]): Array<{ id: string; kind: TranscriptProjectionRow['kind'] }> {
  return rows.map((row) => ({ id: row.id, kind: row.kind }))
}

export function transcriptProjectionRowsEqual(left: TranscriptProjectionRow, right: TranscriptProjectionRow): boolean {
  if (left === right) return true
  if (left.id !== right.id || left.kind !== right.kind) return false
  if (left.kind === 'timeline-item' && right.kind === 'timeline-item') return timelineItemsEqual(left.item, right.item)
  if (left.kind === 'trace-header' && right.kind === 'trace-header') return workTracesEqual(left.trace, right.trace)
  if (left.kind === 'trace-entry' && right.kind === 'trace-entry') return left.traceId === right.traceId && timelineItemsEqual(left.item, right.item)
  if (left.kind === 'trace-notices' && right.kind === 'trace-notices') {
    return left.traceId === right.traceId && left.notices.length === right.notices.length && left.notices.every((notice, index) => timelineItemsEqual(notice, right.notices[index]!))
  }
  if (left.kind === 'trace-files' && right.kind === 'trace-files') {
    return left.traceId === right.traceId && left.paths.length === right.paths.length && left.paths.every((path, index) => path === right.paths[index])
  }
  if (left.kind === 'trace-continuation' && right.kind === 'trace-continuation') return left.traceId === right.traceId && left.remaining === right.remaining
  return false
}

function workTracesEqual(
  left: Extract<DisplayTimelineItem, { kind: 'work-trace' }>,
  right: Extract<DisplayTimelineItem, { kind: 'work-trace' }>,
): boolean {
  return left.id === right.id
    && left.identity === right.identity
    && left.boundaryId === right.boundaryId
    && left.revertEntryId === right.revertEntryId
    && left.changedPaths.length === right.changedPaths.length
    && left.changedPaths.every((path, index) => path === right.changedPaths[index])
    && left.items.length === right.items.length
    && left.items.every((item, index) => timelineItemsEqual(item, right.items[index]!))
}

function timelineItemsEqual(left: TimelineItem, right: TimelineItem | undefined): boolean {
  if (!right) return false
  if (left === right) return true
  if (left.id !== right.id || left.kind !== right.kind) return false
  if ('text' in left || 'text' in right) {
    if (('text' in left ? left.text : undefined) !== ('text' in right ? right.text : undefined)) return false
  }
  if ('streaming' in left || 'streaming' in right) {
    if (Boolean('streaming' in left && left.streaming) !== Boolean('streaming' in right && right.streaming)) return false
  }
  if ('timestamp' in left || 'timestamp' in right) {
    if (('timestamp' in left ? left.timestamp : undefined) !== ('timestamp' in right ? right.timestamp : undefined)) return false
  }
  if ('revertEntryId' in left || 'revertEntryId' in right) {
    if (('revertEntryId' in left ? left.revertEntryId : undefined) !== ('revertEntryId' in right ? right.revertEntryId : undefined)) return false
  }
  if (left.kind === 'user' && right.kind === 'user') return left.images.length === right.images.length
  if (left.kind === 'status' && right.kind === 'status') return left.tone === right.tone
  if (left.kind === 'notice' && right.kind === 'notice') return left.notice.id === right.notice.id && left.notice.message === right.notice.message
  if (left.kind === 'tool' && right.kind === 'tool') {
    return left.tool.id === right.tool.id
      && left.tool.name === right.tool.name
      && left.tool.status === right.tool.status
      && left.tool.isError === right.tool.isError
      && left.tool.output === right.tool.output
      && left.tool.argsText === right.tool.argsText
  }
  if (left.kind === 'compaction' && right.kind === 'compaction') return left.tokensBefore === right.tokensBefore
  if (left.kind === 'context-injection' && right.kind === 'context-injection') {
    return left.source === right.source && left.images.length === right.images.length
  }
  return true
}
