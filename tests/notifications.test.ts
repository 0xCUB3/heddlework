import { describe, expect, it } from 'bun:test'
import { addNotice, createInitialState } from '../src/workbench/state.ts'
import { isLedgerNotice, ledgerNotices } from '../src/workbench/notices.ts'
import { serializeSnapshot } from '../src/protocol/snapshot.ts'

describe('notification ledger state', () => {
  it('retains durable notification history with timestamps instead of only active toasts', () => {
    let state = createInitialState('/tmp/project')
    for (let index = 0; index < 8; index += 1) state = addNotice(state, 'error', `Notice ${index}`)

    expect(state.notices).toHaveLength(8)
    expect(state.notices[0]?.message).toBe('Notice 0')
    expect(state.notices.at(-1)?.message).toBe('Notice 7')
    expect(state.notices.every((item) => item.createdAt > 0 && isLedgerNotice(item))).toBe(true)
  })

  it('omits toasts from the wire snapshot so remotes do not inherit Link copied', () => {
    let state = createInitialState('/tmp/project')
    state = addNotice(state, 'info', 'Link copied')
    state = addNotice(state, 'error', 'Build failed')
    const snapshot = serializeSnapshot(state)
    expect(snapshot.notices.map((item) => item.message)).toEqual(['Build failed'])
    expect(ledgerNotices(state.notices)).toHaveLength(1)
  })
})
