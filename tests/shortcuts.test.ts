import { afterEach, describe, expect, it } from 'bun:test'
import {
  applyShortcutAction,
  formatShortcut,
  resolveShortcut,
  shortcutBus,
  SHORTCUTS,
  type ShortcutKeyEvent,
} from '../src/ui/shortcuts.ts'

const unsubscribers: Array<() => void> = []
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe()
})

function event(partial: ShortcutKeyEvent): ShortcutKeyEvent {
  return partial
}

describe('resolveShortcut', () => {
  it('resolves mod chords on darwin via cmd and elsewhere via ctrl', () => {
    expect(resolveShortcut(event({ key: 'b', modifiers: { cmd: true } }), 'darwin')).toEqual({ action: 'sidebar.toggle' })
    expect(resolveShortcut(event({ key: 'j', modifiers: { cmd: true } }), 'darwin')).toEqual({ action: 'terminal.toggle' })
    expect(resolveShortcut(event({ key: 'd', modifiers: { cmd: true } }), 'darwin')).toEqual({ action: 'diff.toggle' })
    expect(resolveShortcut(event({ key: 'k', modifiers: { cmd: true } }), 'darwin')).toEqual({ action: 'palette.toggle' })
    expect(resolveShortcut(event({ key: 'n', modifiers: { cmd: true } }), 'darwin')).toEqual({ action: 'thread.new' })
    expect(resolveShortcut(event({ key: ',', modifiers: { cmd: true } }), 'darwin')).toEqual({ action: 'settings.open' })
    expect(resolveShortcut(event({ key: 'b', modifiers: { ctrl: true } }), 'linux')).toEqual({ action: 'sidebar.toggle' })
    expect(resolveShortcut(event({ key: 'b', modifiers: { ctrl: true } }), 'win32')).toEqual({ action: 'sidebar.toggle' })
  })

  it('does not fire without the platform mod key or on the other platform glyph', () => {
    expect(resolveShortcut(event({ key: 'b' }), 'darwin')).toBeUndefined()
    expect(resolveShortcut(event({ key: 'b', modifiers: { shift: true } }), 'darwin')).toBeUndefined()
    expect(resolveShortcut(event({ key: 'b', modifiers: { ctrl: true } }), 'darwin')).toBeUndefined()
    expect(resolveShortcut(event({ key: 'b', modifiers: { cmd: true } }), 'linux')).toBeUndefined()
    expect(resolveShortcut(event({ key: 'escape', modifiers: { cmd: true } }), 'darwin')).toBeUndefined()
    expect(resolveShortcut(event({ key: 'x', modifiers: { cmd: true } }), 'darwin')).toBeUndefined()
    expect(resolveShortcut(event({ key: 'escape' }), 'darwin')).toBeUndefined()
  })

  it('matches shift-bracket thread switching whether the key is a bracket or a brace', () => {
    expect(resolveShortcut(event({ key: '[', modifiers: { cmd: true, shift: true } }), 'darwin')).toEqual({ action: 'thread.previous' })
    expect(resolveShortcut(event({ key: '{', modifiers: { cmd: true, shift: true } }), 'darwin')).toEqual({ action: 'thread.previous' })
    expect(resolveShortcut(event({ keyChar: '{', modifiers: { cmd: true, shift: true } }), 'darwin')).toEqual({ action: 'thread.previous' })
    expect(resolveShortcut(event({ key: ']', modifiers: { ctrl: true, shift: true } }), 'linux')).toEqual({ action: 'thread.next' })
    expect(resolveShortcut(event({ key: '}', modifiers: { ctrl: true, shift: true } }), 'linux')).toEqual({ action: 'thread.next' })
    expect(resolveShortcut(event({ key: '[', modifiers: { cmd: true } }), 'darwin')).toBeUndefined()
  })

  it('returns a zero-based jump index for mod+1 through mod+9', () => {
    expect(resolveShortcut(event({ key: '1', modifiers: { cmd: true } }), 'darwin')).toEqual({ action: 'thread.jump', index: 0 })
    expect(resolveShortcut(event({ key: '9', modifiers: { ctrl: true } }), 'linux')).toEqual({ action: 'thread.jump', index: 8 })
    expect(resolveShortcut(event({ key: '0', modifiers: { cmd: true } }), 'darwin')).toBeUndefined()
  })

  it('matches notifications as mod+shift+i and ignores extra alt', () => {
    expect(resolveShortcut(event({ key: 'i', modifiers: { cmd: true, shift: true } }), 'darwin')).toEqual({ action: 'notifications.toggle' })
    expect(resolveShortcut(event({ key: 'i', modifiers: { cmd: true, shift: true, alt: true } }), 'darwin')).toBeUndefined()
  })
})

describe('formatShortcut', () => {
  it('renders glyphs on darwin and Ctrl+ chords elsewhere', () => {
    expect(formatShortcut('mod+b', 'darwin')).toBe('⌘B')
    expect(formatShortcut('mod+b', 'linux')).toBe('Ctrl+B')
    expect(formatShortcut('mod+shift+[', 'darwin')).toBe('⌘⇧[')
    expect(formatShortcut('mod+shift+[', 'linux')).toBe('Ctrl+Shift+[')
    expect(formatShortcut('mod+,', 'darwin')).toBe('⌘,')
    expect(formatShortcut('mod+shift+i', 'darwin')).toBe('⌘⇧I')
    expect(formatShortcut('mod+1', 'linux')).toBe('Ctrl+1')
  })
})

describe('shortcutBus', () => {
  it('notifies newest listeners first and stops at the first that consumes', () => {
    const order: number[] = []
    unsubscribers.push(shortcutBus.subscribe(() => {
      order.push(1)
      return false
    }))
    unsubscribers.push(shortcutBus.subscribe(() => {
      order.push(2)
      return true
    }))
    unsubscribers.push(shortcutBus.subscribe(() => {
      order.push(3)
      return false
    }))
    expect(shortcutBus.dispatch(event({ key: 'z' }))).toBe(true)
    expect(order).toEqual([3, 2])
  })

  it('returns false when nobody consumes, and unsubscribe drops the listener', () => {
    const seen: string[] = []
    const unsubscribe = shortcutBus.subscribe((payload) => {
      seen.push(payload.key ?? '')
      return false
    })
    expect(shortcutBus.dispatch(event({ key: 'z' }))).toBe(false)
    unsubscribe()
    expect(shortcutBus.dispatch(event({ key: 'z' }))).toBe(false)
    expect(seen).toEqual(['z'])
  })
})

describe('applyShortcutAction', () => {
  it('invokes the matching handler and passes jump index', () => {
    const calls: Array<string | number> = []
    expect(applyShortcutAction({ action: 'sidebar.toggle' }, {
      'sidebar.toggle': () => calls.push('sidebar'),
    })).toBe(true)
    expect(applyShortcutAction({ action: 'thread.jump', index: 3 }, {
      'thread.jump': (index) => calls.push(index),
    })).toBe(true)
    expect(applyShortcutAction({ action: 'agent.abort' }, {})).toBe(false)
    expect(applyShortcutAction({ action: 'thread.jump' }, { 'thread.jump': (index) => calls.push(index) })).toBe(false)
    expect(calls).toEqual(['sidebar', 3])
  })
})

describe('SHORTCUTS', () => {
  it('does not bind abort or composer focus by default', () => {
    expect(SHORTCUTS.some((binding) => binding.action === 'agent.abort')).toBe(false)
    expect(SHORTCUTS.some((binding) => binding.action === 'chat.focusComposer')).toBe(false)
  })
})
