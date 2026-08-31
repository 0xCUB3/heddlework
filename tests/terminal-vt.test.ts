import { describe, expect, it } from 'bun:test'
import { VtEmulator } from '../src/terminal/vt.ts'

const ESC = String.fromCharCode(27)

describe('VtEmulator', () => {
  it('prints wrapping text and tracks the cursor', () => {
    const vt = new VtEmulator(8, 3)
    vt.write('hello world')
    const snap = vt.snapshot()
    expect(snap.viewport[0]?.text).toBe('hello wo')
    expect(snap.viewport[1]?.text).toBe('rld')
    expect(snap.cursorX).toBe(3)
    expect(snap.cursorY).toBe(1)
  })

  it('applies SGR colors, bold, and truecolor', () => {
    const vt = new VtEmulator(20, 2)
    vt.write(ESC + '[1;31mred' + ESC + '[0m ' + ESC + '[38;2;10;20;30mtrue')
    const snap = vt.snapshot()
    const red = snap.viewport[0]?.cells[0]
    expect(red?.ch).toBe('r')
    expect(red?.fg).toEqual({ kind: 'indexed', index: 1 })
    expect((red?.attrs ?? 0) & 1).toBe(1)
    const trueCell = snap.viewport[0]?.cells[4]
    expect(trueCell?.fg).toEqual({ kind: 'rgb', r: 10, g: 20, b: 30 })
  })

  it('clears the display, moves the cursor, and sets the title', () => {
    const vt = new VtEmulator(10, 4)
    vt.write('abcd' + ESC + '[H' + ESC + '[2J' + ESC + ']0;Shell' + String.fromCharCode(7) + ESC + '[2;3Hxy')
    const snap = vt.snapshot()
    expect(snap.title).toBe('Shell')
    expect(snap.viewport[0]?.text).toBe('')
    expect(snap.viewport[1]?.text).toBe('  xy')
    expect(snap.cursorX).toBe(4)
    expect(snap.cursorY).toBe(1)
  })

  it('switches to the alternate screen and restores the primary buffer', () => {
    const vt = new VtEmulator(8, 2)
    vt.write('main' + ESC + '[?1049h' + 'alt' + ESC + '[?1049l')
    const snap = vt.snapshot()
    expect(snap.viewport[0]?.text).toBe('main')
  })

  it('reuses immutable rows until their mutable source row changes', () => {
    const vt = new VtEmulator(12, 3)
    vt.write('first' + ESC + '[2;1Hsecond')
    const before = vt.snapshot()

    vt.write(ESC + '[2;7HX')
    const after = vt.snapshot()

    expect(after.viewport[0]).toBe(before.viewport[0])
    expect(after.viewport[1]).not.toBe(before.viewport[1])
    expect(after.viewport[2]).toBe(before.viewport[2])
    vt.write(ESC + '[H')
    const cursorOnly = vt.snapshot()
    expect(cursorOnly.viewport[1]).toBe(after.viewport[1])
  })

  it('tracks DEC synchronized-output boundaries across writes', () => {
    const vt = new VtEmulator(20, 2)
    vt.write(ESC + '[?2026hframe')
    expect(vt.synchronizedOutput).toBe(true)
    vt.write(ESC + '[?202')
    expect(vt.synchronizedOutput).toBe(true)
    vt.write('6l')
    expect(vt.synchronizedOutput).toBe(false)
    expect(vt.snapshot().viewport[0]?.text).toBe('frame')
  })

  it('scrolls lines into scrollback and answers device status', () => {
    const replies: string[] = []
    const vt = new VtEmulator(4, 2)
    vt.onOutput = (data) => replies.push(data)
    vt.write('aaaa\nbbbb\ncccc')
    const snap = vt.snapshot()
    expect(snap.scrollback).toBeGreaterThan(0)
    vt.write(ESC + '[6n')
    expect(replies.some((item) => item.startsWith(ESC + '['))).toBe(true)
  })
})
