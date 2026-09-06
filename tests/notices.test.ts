import { describe, expect, it } from 'bun:test'
import {
  appendNotice,
  classifyNotice,
  isLedgerNotice,
  isToastNotice,
  ledgerNotices,
  markLedgerRead,
  markNoticeRead,
  unreadLedgerNotices,
  type Notice,
} from '../src/workbench/notices.ts'
import { addNotice, createInitialState } from '../src/workbench/state.ts'

function notice(partial: Partial<Notice> & Pick<Notice, 'id' | 'message'>): Notice {
  return { kind: 'info', createdAt: partial.id, channel: 'ledger', ...partial }
}

describe('notice taxonomy', () => {
  it('keeps copy and settle confirmations as toasts, not ledger events', () => {
    expect(classifyNotice('info', 'Link copied')).toEqual({ channel: 'toast', reason: 'local' })
    expect(classifyNotice('info', 'Thread moved to Settled')).toEqual({ channel: 'toast', reason: 'local' })
    expect(classifyNotice('info', 'Copied last assistant message to clipboard')).toEqual({ channel: 'toast', reason: 'local' })
    expect(classifyNotice('warning', 'Pi disconnected — reconnecting automatically…')).toEqual({ channel: 'toast', reason: 'status' })
  })

  it('keeps failures, completions, and input as durable ledger events', () => {
    expect(classifyNotice('error', 'Pi keeps disconnecting — automatic reconnection gave up. Press Reconnect to try again.')).toEqual({ channel: 'ledger', reason: 'failure' })
    expect(classifyNotice('warning', 'Could not load earlier transcript: boom')).toEqual({ channel: 'ledger', reason: 'failure' })
    expect(classifyNotice('info', 'Turn finished', { channel: 'ledger', reason: 'completion' })).toEqual({ channel: 'ledger', reason: 'completion' })
    expect(classifyNotice('info', 'Heddlework 0.9.0 is available (running 0.8.0). Download: https://example.test/latest')).toEqual({ channel: 'ledger', reason: 'status' })
  })

  it('dedups by eventId, bounds ledger retention, and tracks read state', () => {
    let notices: Notice[] = []
    for (let index = 0; index < 60; index += 1) {
      notices = appendNotice(notices, notice({ id: index + 1, eventId: `e${index}`, message: `N${index}` }))
    }
    notices = appendNotice(notices, notice({ id: 999, eventId: 'e40', message: 'dup' }))
    expect(notices).toHaveLength(50)
    expect(notices[0]?.message).toBe('N10')
    expect(notices.find((item) => item.eventId === 'e40')?.message).toBe('N40')
    expect(unreadLedgerNotices(notices)).toHaveLength(50)
    notices = markNoticeRead(notices, notices[0]!.id)
    expect(unreadLedgerNotices(notices)).toHaveLength(49)
    notices = markLedgerRead(notices)
    expect(unreadLedgerNotices(notices)).toHaveLength(0)
  })

  it('does not put toasts into the serialized ledger filter', () => {
    let state = createInitialState('/tmp/project')
    state = addNotice(state, 'info', 'Link copied')
    state = addNotice(state, 'error', 'Task failed')
    expect(state.notices.map((item) => item.channel)).toEqual(['toast', 'ledger'])
    expect(ledgerNotices(state.notices)).toHaveLength(1)
    expect(ledgerNotices(state.notices)[0]?.message).toBe('Task failed')
    expect(isToastNotice(state.notices[0]!)).toBe(true)
    expect(isLedgerNotice(state.notices[1]!)).toBe(true)
    expect(state.notices[1]?.action?.type).toBeUndefined()
  })
})
