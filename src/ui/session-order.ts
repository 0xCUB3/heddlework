import type { PiSessionSummary } from '../pi/session-catalog.ts'

export function compareSessionsByRecency(left: PiSessionSummary, right: PiSessionSummary): number {
  return right.modifiedAt - left.modifiedAt
}

export function orderedActiveSessions(sessions: readonly PiSessionSummary[]): PiSessionSummary[] {
  return sessions.filter((session) => session.messageCount > 0).slice().sort(compareSessionsByRecency)
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
