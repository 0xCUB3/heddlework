import { describe, expect, it } from 'bun:test'
import {
  CELL_BOLD,
  CELL_DIM,
  CELL_HIDDEN,
  CELL_INVERSE,
  CELL_SPACER,
  CELL_WIDE,
  type TerminalAppearance,
  type TerminalCell,
  type TerminalGridSnapshot,
  type TerminalRow,
} from '../src/terminal/types.ts'
import { VtEmulator } from '../src/terminal/vt.ts'
import { TERMINAL_CELL_WIDTH } from '../src/ui/terminal-metrics.ts'
import {
  NATIVE_CELL_BOLD,
  NATIVE_CELL_FILL,
  NATIVE_CELL_SPACER,
  NATIVE_CELL_WIDE,
  NATIVE_TERMINAL_CELL_BYTES,
  terminalNativeBinaryFrame,
  terminalNativeFrame,
} from '../src/ui/terminal-native.ts'
import { paintTerminalCell, terminalPaintTheme } from '../src/ui/terminal-theme.ts'

const DEFAULT_FG = { kind: 'default-fg' } as const
const DEFAULT_BG = { kind: 'default-bg' } as const
const APPEARANCE: TerminalAppearance = {
  fontFamily: 'Menlo',
  nerdFontFamily: 'Symbols Nerd Font Mono',
  ligaturesEnabled: true,
  nerdFontEnabled: false,
  muteEmojiColors: true,
}

function cell(ch: string, options: Partial<TerminalCell> = {}): TerminalCell {
  return {
    ch,
    fg: options.fg ?? DEFAULT_FG,
    bg: options.bg ?? DEFAULT_BG,
    attrs: options.attrs ?? 0,
  }
}

function snapshot(rows: readonly TerminalRow[], cols: number): TerminalGridSnapshot {
  return {
    cols,
    rows: rows.length,
    cursorX: 2,
    cursorY: 0,
    cursorVisible: true,
    applicationCursor: false,
    bracketedPaste: false,
    title: '',
    viewport: rows,
    scrollback: 0,
    scrollOffset: 0,
  }
}

function decoded(cells: string): DataView {
  const bytes = Buffer.from(cells, 'base64')
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
}

describe('native terminal frame projection', () => {
  it('exposes identical raw and base64 native transports', () => {
    const grid = snapshot([{ cells: [cell('A'), cell('█')], text: 'A█' }], 2)
    const theme = terminalPaintTheme('dark')
    const binary = terminalNativeBinaryFrame(grid, theme, APPEARANCE)
    const encoded = terminalNativeFrame(grid, theme, APPEARANCE)

    expect(binary.cells).toBeInstanceOf(Uint8Array)
    expect(binary.cells.byteLength).toBe(2 * NATIVE_TERMINAL_CELL_BYTES)
    expect(Buffer.from(binary.cells).toString('base64')).toBe(encoded.cells)
    expect({ ...binary, cells: encoded.cells }).toEqual(encoded)
  })

  it('reuses only an exactly sized and aligned direct-transport cell buffer', () => {
    const grid = snapshot([{ cells: [cell('A'), cell('B')], text: 'AB' }], 2)
    const theme = terminalPaintTheme('dark')
    const reusable = new Uint8Array(2 * NATIVE_TERMINAL_CELL_BYTES)
    reusable.fill(0xff)

    const misaligned = new Uint8Array(reusable.byteLength + 1).subarray(1)
    const reused = terminalNativeBinaryFrame(grid, theme, APPEARANCE, reusable)
    const realigned = terminalNativeBinaryFrame(grid, theme, APPEARANCE, misaligned)
    const resized = terminalNativeBinaryFrame(grid, theme, APPEARANCE, reusable.subarray(1))

    expect(reused.cells).toBe(reusable)
    expect(reused.cells[15]).toBe(0)
    expect(realigned.cells).not.toBe(misaligned)
    expect(realigned.cells.byteOffset % Uint32Array.BYTES_PER_ELEMENT).toBe(0)
    expect(resized.cells).not.toBe(reusable)
    expect(resized.cells.byteLength).toBe(reusable.byteLength)
  })

  it('packs glyphs, final colors, and cell flags into a fixed-width binary stream', () => {
    const cells = [
      cell('A', { attrs: CELL_BOLD }),
      cell('界', { attrs: CELL_WIDE }),
      cell(' ', { attrs: CELL_SPACER }),
      cell('D', { fg: { kind: 'indexed', index: 1 } }),
    ]
    const frame = terminalNativeFrame(
      snapshot([{ cells, text: 'A界D' }], 4),
      terminalPaintTheme('dark'),
      APPEARANCE,
    )
    const view = decoded(frame.cells)

    expect(view.byteLength).toBe(4 * NATIVE_TERMINAL_CELL_BYTES)
    expect(view.getUint32(0, true)).toBe('A'.codePointAt(0)!)
    expect(view.getUint16(12, true) & NATIVE_CELL_BOLD).toBe(NATIVE_CELL_BOLD)
    expect(view.getUint32(16, true)).toBe('界'.codePointAt(0)!)
    expect(view.getUint16(28, true) & NATIVE_CELL_WIDE).toBe(NATIVE_CELL_WIDE)
    expect(view.getUint16(44, true) & NATIVE_CELL_SPACER).toBe(NATIVE_CELL_SPACER)
    expect(view.getUint32(52, true)).toBe(0xe5484d)
    expect(frame.cursorX).toBe(2)
    expect(frame.cursorVisible).toBe(true)
  })

  it('matches canonical color painting across fast and contrast-safe paths', () => {
    const cells = [
      cell('A', { fg: { kind: 'indexed', index: 1 }, attrs: CELL_BOLD }),
      cell('B', { fg: { kind: 'indexed', index: 2 }, bg: { kind: 'indexed', index: 4 }, attrs: CELL_INVERSE }),
      cell('C', { fg: { kind: 'rgb', r: 8, g: 120, b: 240 }, attrs: CELL_HIDDEN }),
      cell('D', { fg: { kind: 'rgb', r: 120, g: 130, b: 140 }, attrs: CELL_DIM }),
    ]
    for (const appearance of ['dark', 'light'] as const) {
      const theme = terminalPaintTheme(appearance)
      const frame = terminalNativeFrame(snapshot([{ cells, text: 'ABCD' }], 4), theme, APPEARANCE)
      const view = decoded(frame.cells)
      for (let index = 0; index < cells.length; index += 1) {
        const painted = paintTerminalCell(cells[index]!, theme)
        expect(view.getUint32(index * NATIVE_TERMINAL_CELL_BYTES + 4, true)).toBe(Number.parseInt(painted.color.slice(1), 16))
        expect(view.getUint32(index * NATIVE_TERMINAL_CELL_BYTES + 8, true)).toBe(Number.parseInt(painted.backgroundColor.slice(1), 16))
      }
    }
  })

  it('marks only a full block as a whole-cell image fill', () => {
    const frame = terminalNativeFrame(
      snapshot([{ cells: [cell('█'), cell('▌')], text: '█▌' }], 2),
      terminalPaintTheme('dark'),
      APPEARANCE,
    )
    const view = decoded(frame.cells)

    expect(view.getUint16(12, true) & NATIVE_CELL_FILL).toBe(NATIVE_CELL_FILL)
    expect(view.getUint16(NATIVE_TERMINAL_CELL_BYTES + 12, true) & NATIVE_CELL_FILL).toBe(0)
  })

  it('stores multi-codepoint graphemes once outside the cell buffer', () => {
    const frame = terminalNativeFrame(
      snapshot([{ cells: [cell('🙂')], text: '🙂' }], 1),
      terminalPaintTheme('dark'),
      APPEARANCE,
    )
    const view = decoded(frame.cells)

    expect(view.getUint32(0, true) >>> 31).toBe(1)
    expect(frame.graphemes).toEqual(['🙂\uFE0E'])
  })

  it('projects packed VT rows identically to materialized terminal cells', () => {
    const vt = new VtEmulator(12, 2)
    vt.write('\x1b[1;31mA\x1b[0m界e\u0301█🙂')
    const packed = vt.snapshot()
    const { packedViewport: _packedViewport, ...publicSnapshot } = packed
    const materialized: TerminalGridSnapshot = {
      ...publicSnapshot,
      viewport: packed.viewport,
    }
    const nerdAppearance = { ...APPEARANCE, nerdFontEnabled: true }

    for (const appearance of ['dark', 'light'] as const) {
      const theme = terminalPaintTheme(appearance)
      expect(terminalNativeFrame(packed, theme, nerdAppearance))
        .toEqual(terminalNativeFrame(materialized, theme, nerdAppearance))
    }
  })

  it('uses GPUI Menlo metrics and keeps a dense 100-column box payload bounded', () => {
    const cells = Array.from({ length: 100 }, () => cell('─'))
    const frame = terminalNativeFrame(
      snapshot([{ cells, text: '─'.repeat(100) }], 100),
      terminalPaintTheme('dark'),
      APPEARANCE,
    )
    const view = decoded(frame.cells)

    expect(frame.cellWidth).toBe(7.83)
    expect(frame.cellWidth).toBe(TERMINAL_CELL_WIDTH)
    expect(frame.cols * frame.cellWidth).toBeCloseTo(783, 5)
    expect(view.byteLength).toBe(100 * NATIVE_TERMINAL_CELL_BYTES)
    expect(view.getUint32(99 * NATIVE_TERMINAL_CELL_BYTES, true)).toBe('─'.codePointAt(0)!)
    expect(JSON.stringify(frame).length).toBeLessThan(3_000)
  })
})
