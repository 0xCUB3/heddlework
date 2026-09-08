import type { PiSessionSummary } from './session-catalog.ts'

export function compareSessionsByActivity(left: PiSessionSummary, right: PiSessionSummary): number {
  const recency = right.modifiedAt - left.modifiedAt
  if (recency !== 0) return recency
  if (left.path < right.path) return -1
  if (left.path > right.path) return 1
  return 0
}
