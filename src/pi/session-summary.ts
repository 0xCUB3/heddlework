import { basename } from 'node:path'
import type { PiSessionSummary } from './session-catalog.ts'

export function sessionProjectName(session: Pick<PiSessionSummary, 'cwd'>): string {
  return basename(session.cwd) || session.cwd || 'Unknown project'
}

export function isCurrentPiSession(
  session: Pick<PiSessionSummary, 'id' | 'path'>,
  current: { sessionId?: string | undefined; sessionFile?: string | undefined },
): boolean {
  if (current.sessionFile) return session.path === current.sessionFile
  return Boolean(current.sessionId) && session.id === current.sessionId
}
