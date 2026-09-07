import { describe, expect, it } from 'bun:test'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket, sortActiveSessions } from '../src/ui/sidebar.tsx'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

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

  it('gives explicit snooze and restore state precedence until a later run reopens the session', () => {
    const old = session(now - SESSION_SETTLED_AFTER_MS * 2)
    expect(sessionLifecycleBucket(old, { snoozedUntil: now + 1_000 }, now)).toBe('snoozed')
    expect(sessionLifecycleBucket(session(now - 2_000), { settledAt: now - 1_000 }, now)).toBe('settled')
    expect(sessionLifecycleBucket(old, { unsettledAt: now - 1_000 }, now)).toBe('active')
    expect(sessionLifecycleBucket(session(now), { settledAt: now - 1_000 }, now)).toBe('active')
  })

  it('sorts pinned active threads ahead of recency', () => {
    const older = { ...session(now - 5_000), id: 'older', path: '/tmp/older.jsonl', title: 'Older' }
    const pinned = { ...session(now - 8_000), id: 'pinned', path: '/tmp/pinned.jsonl', title: 'Pinned' }
    const newer = { ...session(now - 1_000), id: 'newer', path: '/tmp/newer.jsonl', title: 'Newer' }
    expect(sortActiveSessions([older, pinned, newer], { [pinned.path]: { pinnedAt: now - 100 } }).map((entry) => entry.id)).toEqual([
      'pinned', 'newer', 'older',
    ])
  })

  it('clears pinnedAt when a thread is settled and keeps it when snoozed', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/project', testControllerDependencies())
    try {
      controller.pinThread('/tmp/session.jsonl')
      expect(controller.getSnapshot().threadLifecycle['/tmp/session.jsonl']?.pinnedAt).toBeNumber()
      controller.snoozeThread('/tmp/session.jsonl', now + 60_000)
      expect(controller.getSnapshot().threadLifecycle['/tmp/session.jsonl']?.pinnedAt).toBeNumber()
      controller.settleThread('/tmp/session.jsonl')
      expect(controller.getSnapshot().threadLifecycle['/tmp/session.jsonl']?.pinnedAt).toBeUndefined()
      expect(controller.getSnapshot().threadLifecycle['/tmp/session.jsonl']?.settledAt).toBeNumber()
    } finally {
      await controller.dispose()
    }
  })
})
