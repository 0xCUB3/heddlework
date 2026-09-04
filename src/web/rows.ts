import { groupWorkItems, projectTranscriptRows, type TranscriptProjectionRow } from '../ui/transcript-projection.ts'
import { buildTimeline } from '../workbench/timeline.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'

export function projectWorkspaceRows(
  state: WorkbenchSnapshot,
  expandedTraceIds: ReadonlySet<string> = new Set(),
  traceLimits: ReadonlyMap<string, number> = new Map(),
): TranscriptProjectionRow[] {
  const items = buildTimeline(state.messages, state.liveAssistant, state.liveTools, state.forkMessages)
  return projectTranscriptRows(groupWorkItems(items, state.session.isStreaming), expandedTraceIds, traceLimits)
}

export function workspaceRowKinds(rows: readonly TranscriptProjectionRow[]): string[] {
  return rows.map((row) => row.kind)
}
