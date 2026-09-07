import { describe, expect, it } from 'bun:test'
import { buildThreadActions } from '../src/ui/thread-actions.ts'

const idle = {
  isPinned: false,
  isSettled: false,
  isSnoozed: false,
  isRunning: false,
  hasMessages: true,
}

describe('buildThreadActions', () => {
  it('shows pin when unpinned and unpin when pinned', () => {
    expect(buildThreadActions(idle).map((action) => action.id)).toEqual([
      'pin', 'rename', 'regenerate-title', 'copy-path', 'copy-thread-id', 'clone', 'export', 'settle', 'snooze',
    ])
    expect(buildThreadActions(idle).find((action) => action.id === 'pin')?.label).toBe('Pin thread')
    const pinned = buildThreadActions({ ...idle, isPinned: true })
    expect(pinned.map((action) => action.id)[0]).toBe('unpin')
    expect(pinned.find((action) => action.id === 'unpin')?.label).toBe('Unpin thread')
    expect(pinned.some((action) => action.id === 'pin')).toBe(false)
  })

  it('treats a settled thread as unpinned and offers unsettle instead of settle', () => {
    const actions = buildThreadActions({ ...idle, isPinned: true, isSettled: true })
    expect(actions.map((action) => action.id)).toEqual([
      'pin', 'rename', 'regenerate-title', 'copy-path', 'copy-thread-id', 'clone', 'export', 'unsettle', 'snooze',
    ])
    expect(actions.some((action) => action.id === 'unpin')).toBe(false)
  })

  it('offers wake instead of snooze while snoozed', () => {
    expect(buildThreadActions({ ...idle, isSnoozed: true }).map((action) => action.id).at(-1)).toBe('wake')
  })

  it('disables rename and settle while a run is in progress', () => {
    const actions = buildThreadActions({ ...idle, isRunning: true })
    expect(actions.find((action) => action.id === 'rename')).toMatchObject({ disabled: true, label: 'Rename thread' })
    expect(actions.find((action) => action.id === 'settle')).toMatchObject({ disabled: true, label: 'Settle thread' })
    expect(actions.find((action) => action.id === 'clone')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'export')?.disabled).toBe(true)
  })

  it('disables clone and export when the thread has no messages', () => {
    const actions = buildThreadActions({ ...idle, hasMessages: false })
    expect(actions.find((action) => action.id === 'clone')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'export')?.disabled).toBe(true)
    expect(actions.find((action) => action.id === 'rename')?.disabled).toBeUndefined()
    expect(actions.find((action) => action.id === 'settle')?.disabled).toBeUndefined()
  })
})
