import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { ThreadLifecycle } from './state.ts'

export const SESSION_SETTLED_AFTER_MS = 7 * 24 * 60 * 60 * 1_000

export function sessionLifecycleBucket(session: PiSessionSummary, lifecycle: ThreadLifecycle | undefined, now: number): 'active' | 'snoozed' | 'settled' {
  if ((lifecycle?.snoozedUntil ?? 0) > now) return 'snoozed'
  if ((lifecycle?.settledAt ?? 0) >= session.modifiedAt) return 'settled'
  if ((lifecycle?.unsettledAt ?? 0) > session.modifiedAt) return 'active'
  if (now - session.modifiedAt > SESSION_SETTLED_AFTER_MS) return 'settled'
  return 'active'
}
