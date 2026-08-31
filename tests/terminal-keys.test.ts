import { describe, expect, it } from 'bun:test'
import { encodeTerminalKey, wrapBracketedPaste } from '../src/terminal/keys.ts'

const ESC = String.fromCharCode(27)

describe('encodeTerminalKey', () => {
  it('encodes printable, control, navigation, and editing keys', () => {
    expect(encodeTerminalKey({ key: 'a', keyChar: 'a' })).toBe('a')
    expect(encodeTerminalKey({ key: 'enter' })).toBe('\r')
    expect(encodeTerminalKey({ key: 'c', modifiers: { ctrl: true } })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ key: 'up' })).toBe(ESC + '[A')
    expect(encodeTerminalKey({ key: 'up' }, true)).toBe(ESC + 'OA')
    expect(encodeTerminalKey({ key: 'backspace' })).toBe(String.fromCharCode(0x7f))
    expect(encodeTerminalKey({ key: 'arrowdown' })).toBe(ESC + '[B')
    expect(encodeTerminalKey({ key: 'ctrl-c' })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ keyChar: String.fromCharCode(3) })).toBe(String.fromCharCode(3))
    expect(encodeTerminalKey({ keyChar: String.fromCharCode(8) })).toBe(String.fromCharCode(0x7f))
  })

  it('lets the view handle copy and paste shortcuts', () => {
    expect(encodeTerminalKey({ key: 'c', modifiers: { cmd: true } })).toBeUndefined()
    expect(encodeTerminalKey({ key: 'v', modifiers: { cmd: true } })).toBeUndefined()
  })

  it('wraps bracketed paste when the emulator enabled it', () => {
    expect(wrapBracketedPaste('hi', false)).toBe('hi')
    expect(wrapBracketedPaste('hi', true)).toBe(ESC + '[200~hi' + ESC + '[201~')
  })
})
