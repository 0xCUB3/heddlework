import { describe, expect, it } from 'bun:test'
import {
  CELL_BOLD,
  CELL_DIM,
  CELL_SPACER,
  CELL_WIDE,
  type TerminalAppearance,
  type TerminalCell,
} from '../src/terminal/types.ts'
import { contrastRatio } from '../src/ui/terminal-color.ts'
import {
  isNerdFontGlyph,
  isTerminalFillGlyph,
  isTerminalGraphicsGlyph,
  muteEmojiPresentation,
  paintTerminalCell,
  terminalPaintTheme,
  terminalRowRuns,
} from '../src/ui/terminal-theme.ts'

const DEFAULT_FG = { kind: 'default-fg' } as const
const DEFAULT_BG = { kind: 'default-bg' } as const
const APPEARANCE: TerminalAppearance = {
  fontFamily: 'Fira Code',
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

describe('terminal native paint theme', () => {
  it('builds deterministic theme-derived 256-color palettes', () => {
    const dark = terminalPaintTheme('dark')
    const light = terminalPaintTheme('light')
    expect(dark.ansi).toHaveLength(256)
    expect(light.ansi).toHaveLength(256)
    expect(dark.ansi[16]).toBe(dark.background.toLowerCase())
    expect(light.ansi[16]).toBe(light.foreground.toLowerCase())
    expect(light.ansi[255]).toBeDefined()
  })

  it('enforces WCAG contrast after gamma-aware dimming on light backgrounds', () => {
    const theme = terminalPaintTheme('light')
    const lowContrast = cell('x', {
      fg: { kind: 'rgb', r: 190, g: 190, b: 190 },
      attrs: CELL_DIM,
    })
    const painted = paintTerminalCell(lowContrast, theme)
    expect(painted.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(contrastRatio(painted.backgroundColor, painted.color)).toBeGreaterThanOrEqual(4.49)
  })

  it('only promotes a full block to a cell fill while preserving all block colors', () => {
    expect(isTerminalFillGlyph('█')).toBe(true)
    expect(isTerminalFillGlyph('▌')).toBe(false)
    expect(isTerminalGraphicsGlyph('▌')).toBe(true)
    expect(isTerminalGraphicsGlyph('A')).toBe(false)
    const block = cell('▌', {
      fg: { kind: 'rgb', r: 1, g: 2, b: 3 },
      bg: { kind: 'rgb', r: 4, g: 5, b: 6 },
    })
    const painted = paintTerminalCell(block, terminalPaintTheme('light'))
    expect(painted.color).toBe('#010203')
    expect(terminalRowRuns([block], terminalPaintTheme('dark'), APPEARANCE)[0]?.fill).toBe(false)
  })

  it('maps bold base ANSI colors to their bright variants', () => {
    const theme = terminalPaintTheme('dark')
    const painted = paintTerminalCell(cell('x', {
      fg: { kind: 'indexed', index: 1 },
      attrs: CELL_BOLD,
    }), theme)
    expect(painted.color).toBe(theme.ansi[9]!)
    expect(painted.fontWeight).toBe(700)
  })

  it('uses native shaping by default and can inhibit cross-cell ligatures', () => {
    const theme = terminalPaintTheme('dark')
    const cells = [cell('='), cell('>')]
    expect(terminalRowRuns(cells, theme, APPEARANCE)[0]?.text).toBe('=>')
    expect(terminalRowRuns(cells, theme, { ...APPEARANCE, ligaturesEnabled: false })[0]?.text).toBe('=\u200C>')
  })

  it('keeps the cell after a wide glyph on its own native shaping run', () => {
    const theme = terminalPaintTheme('dark')
    const runs = terminalRowRuns([
      cell('界', { attrs: CELL_WIDE }),
      cell('', { attrs: CELL_SPACER }),
      cell('x'),
    ], theme, APPEARANCE)
    expect(runs).toHaveLength(2)
    expect(runs.map((run) => run.columns)).toEqual([2, 1])
    expect(runs.map((run) => run.text)).toEqual(['界', 'x'])
  })

  it('routes Nerd Font ranges through a runtime fallback family', () => {
    const theme = terminalPaintTheme('dark')
    const glyph = '\uE0B0'
    expect(isNerdFontGlyph(glyph)).toBe(true)
    const runs = terminalRowRuns([cell(glyph), cell('a')], theme, {
      ...APPEARANCE,
      nerdFontEnabled: true,
    })
    expect(runs[0]?.fontFamily).toBe('Symbols Nerd Font Mono')
    expect(runs[1]?.fontFamily).toBe('Fira Code')
  })

  it('requests text-presentation emoji while preserving cell width', () => {
    const muted = muteEmojiPresentation('🙂' + '\uFE0F')
    expect(muted).not.toContain('\uFE0F')
    expect(muted).toContain('\uFE0E')
    const runs = terminalRowRuns([cell('🙂')], terminalPaintTheme('dark'), APPEARANCE)
    expect(runs[0]?.columns).toBe(1)
    expect(runs[0]?.text).toContain('\uFE0E')
  })
})
