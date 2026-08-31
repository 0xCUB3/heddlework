import { describe, expect, it } from 'bun:test'
import type {
  TerminalAppearance,
  TerminalCell,
  TerminalGridSnapshot,
  TerminalRow,
} from '../src/terminal/types.ts'
import { TERMINAL_CELL_WIDTH } from '../src/ui/terminal-metrics.ts'
import { terminalNativeFrame } from '../src/ui/terminal-native.ts'
import { terminalPaintTheme } from '../src/ui/terminal-theme.ts'

const DEFAULT_FG = { kind: 'default-fg' } as const
const DEFAULT_BG = { kind: 'default-bg' } as const
const APPEARANCE: TerminalAppearance = {
  fontFamily: 'Menlo',
  nerdFontFamily: 'Symbols Nerd Font Mono',
  ligaturesEnabled: true,
  nerdFontEnabled: false,
  muteEmojiColors: true,
}

function cell(ch: string, fg: TerminalCell['fg'] = DEFAULT_FG): TerminalCell {
  return { ch, fg, bg: DEFAULT_BG, attrs: 0 }
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

describe('native terminal frame projection', () => {
  it('deduplicates styles and preserves exact run columns in a compact tuple stream', () => {
    const cells = [
      cell('A'),
      cell('B'),
      cell('C', { kind: 'indexed', index: 1 }),
      cell('D', { kind: 'indexed', index: 1 }),
    ]
    const frame = terminalNativeFrame(
      snapshot([{ cells, text: 'ABCD' }], 4),
      terminalPaintTheme('dark'),
      APPEARANCE,
    )

    expect(frame.styles).toHaveLength(2)
    expect(frame.runs).toEqual([
      [0, 0, 2, 0, 'AB'],
      [0, 2, 2, 1, 'CD'],
    ])
    expect(frame.cursorX).toBe(2)
    expect(frame.cursorVisible).toBe(true)
  })

  it('uses GPUI Menlo metrics so long box runs end on the final grid column', () => {
    const cells = Array.from({ length: 100 }, () => cell('─'))
    const frame = terminalNativeFrame(
      snapshot([{ cells, text: '─'.repeat(100) }], 100),
      terminalPaintTheme('dark'),
      APPEARANCE,
    )

    expect(frame.cellWidth).toBe(7.83)
    expect(frame.cellWidth).toBe(TERMINAL_CELL_WIDTH)
    expect(frame.runs).toEqual([[0, 0, 100, 0, '─'.repeat(100)]])
    expect(frame.cols * frame.cellWidth).toBeCloseTo(783, 5)
  })
})
