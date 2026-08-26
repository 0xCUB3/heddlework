import { describe, expect, it } from 'bun:test'
import { addNotice, createInitialState } from '../src/workbench/state.ts'

describe('notification ledger state', () => {
  it('retains notification history with timestamps instead of only active toasts', () => {
    let state = createInitialState('/tmp/project')
    for (let index = 0; index < 8; index += 1) state = addNotice(state, 'info', `Notice ${index}`)

    expect(state.notices).toHaveLength(8)
    expect(state.notices[0]?.message).toBe('Notice 0')
    expect(state.notices.at(-1)?.message).toBe('Notice 7')
    expect(state.notices.every((notice) => notice.createdAt > 0)).toBe(true)
  })
})
