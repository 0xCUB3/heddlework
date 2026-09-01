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

  it('matches complete-CSI fast parsing with bytewise streaming', () => {
    const output = '\u001b[2;3H\u001b[38;2;1;2;3mX\u001b[48;2;4;5;6mY\u001b[0m'
    const complete = new VtEmulator(8, 4)
    const streamed = new VtEmulator(8, 4)
    complete.write(output)
    for (const byte of new TextEncoder().encode(output)) streamed.write(new Uint8Array([byte]))

    expect(streamed.snapshot()).toEqual(complete.snapshot())
  })

  it('matches fused truecolor block runs with bytewise VT parsing', () => {
    const output = ESC + '[1m'
      + ESC + '[2;3H' + ESC + '[38;2;1;2;3m' + ESC + '[48;2;4;5;6m' + '▀██▖' + ESC + '[0m'
      + ESC + '[3;2H' + ESC + '[38;2;250;240;230m' + ESC + '[48;2;20;30;40m' + '▙▛' + ESC + '[0m'
    const complete = new VtEmulator(8, 4)
    const streamed = new VtEmulator(8, 4)
    complete.write(output)
    for (const byte of new TextEncoder().encode(output)) streamed.write(new Uint8Array([byte]))

    expect(complete.snapshot()).toEqual(streamed.snapshot())
    const first = complete.snapshot().viewport[1]!.cells[2]!
    expect(first).toEqual({
      ch: '▀',
      fg: { kind: 'rgb', r: 1, g: 2, b: 3 },
      bg: { kind: 'rgb', r: 4, g: 5, b: 6 },
      attrs: 1,
    })
    expect(complete.snapshot().viewport[2]!.cells[1]?.attrs).toBe(0)
  })

  it('parses numeric CSI state incrementally across arbitrary chunks', () => {
    const vt = new VtEmulator(10, 2)
    vt.write(ESC + '[38;2;10')
    vt.write(';20;30mX' + ESC + '[;5HY')
    vt.write('Z')
    const snap = vt.snapshot()
    expect(snap.viewport[0]?.cells[0]?.fg).toEqual({ kind: 'rgb', r: 10, g: 20, b: 30 })
    expect(snap.viewport[0]?.cells[4]?.ch).toBe('Y')
    expect(snap.viewport[0]?.cells[5]?.ch).toBe('Z')
  })

  it('erases through the final column with the active background rendition', () => {
    const vt = new VtEmulator(8, 2)
    vt.write(ESC + '[44mX' + ESC + '[K')
    let row = vt.snapshot().viewport[0]!.cells
    expect(row[1]?.bg).toEqual({ kind: 'indexed', index: 4 })
    expect(row[7]?.bg).toEqual({ kind: 'indexed', index: 4 })

    vt.write(ESC + '[2;1H' + ESC + '[0;7mY' + ESC + '[K')
    row = vt.snapshot().viewport[1]!.cells
    expect(row[1]?.attrs).toBe(1 << 5)
    expect(row[7]?.attrs).toBe(1 << 5)
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
    expect(before.viewport[1]?.text).toBe('second')
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
