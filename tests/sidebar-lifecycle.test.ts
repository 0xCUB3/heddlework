import { describe, expect, it } from 'bun:test'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket } from '../src/ui/sidebar.tsx'

const now = 2_000_000_000_000

function session(modifiedAt: number): PiSessionSummary {
  return {
    id: 'session',
    path: '/tmp/session.jsonl',
    cwd: '/tmp/project',
    title: 'Session',
    firstMessage: 'Prompt',
    messageCount: 1,
    createdAt: modifiedAt,
    modifiedAt,
  }
}

describe('sidebar session lifecycle', () => {
  it('considers sessions older than one week settled', () => {
    expect(sessionLifecycleBucket(session(now - SESSION_SETTLED_AFTER_MS - 1), undefined, now)).toBe('settled')
    expect(sessionLifecycleBucket(session(now - SESSION_SETTLED_AFTER_MS), undefined, now)).toBe('active')
  })

  it('gives explicit snooze, settle, and restore state precedence', () => {
    const old = session(now - SESSION_SETTLED_AFTER_MS * 2)
    expect(sessionLifecycleBucket(old, { snoozedUntil: now + 1_000 }, now)).toBe('snoozed')
    expect(sessionLifecycleBucket(session(now), { settledAt: now - 1_000 }, now)).toBe('settled')
    expect(sessionLifecycleBucket(old, { unsettledAt: now - 1_000 }, now)).toBe('active')
  })
})
