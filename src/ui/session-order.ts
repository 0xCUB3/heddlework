import { compareSessionsByActivity } from '../pi/session-activity.ts'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import { sortActiveSessions } from '../workbench/thread-lifecycle.ts'
import type { ThreadLifecycle } from '../workbench/state.ts'

export function compareSessionsByRecency(left: PiSessionSummary, right: PiSessionSummary): number {
  return compareSessionsByActivity(left, right)
}

// One ordering for the sidebar, Cmd+1..9, previous/next, and the palette: pinned first, then most recent.
export function orderedActiveSessions(sessions: readonly PiSessionSummary[], lifecycle: Record<string, ThreadLifecycle> = {}): PiSessionSummary[] {
  return sortActiveSessions(sessions.filter((session) => session.messageCount > 0), lifecycle)
}

export function adjacentSession(
  sessions: readonly PiSessionSummary[],
  currentPath: string | undefined,
  delta: 1 | -1,
): PiSessionSummary | undefined {
  if (sessions.length === 0) return undefined
  const index = currentPath ? sessions.findIndex((session) => session.path === currentPath) : -1
  if (index < 0) return delta > 0 ? sessions[0] : sessions[sessions.length - 1]
  return sessions[(index + delta + sessions.length) % sessions.length]
}
