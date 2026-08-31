import {
  CELL_BOLD,
  CELL_DIM,
  CELL_HIDDEN,
  CELL_INVERSE,
  CELL_ITALIC,
  CELL_SPACER,
  CELL_STRIKE,
  CELL_UNDERLINE,
  CELL_WIDE,
  type TerminalCell,
  type TerminalColor,
} from '../terminal/types.ts'
import type { ResolvedTheme } from './theme.ts'

const DARK_ANSI = [
  '#0D0D0D', '#E5484D', '#46A758', '#EF9F27', '#52A9FF', '#BF7AF0', '#12A594', '#EDEDEF',
  '#6F6E77', '#FF6369', '#70D083', '#FFC36A', '#82C4FF', '#D4A4FF', '#3BD4C0', '#FFFFFF',
]

const LIGHT_ANSI = [
  '#1D1D20', '#C43D45', '#16845B', '#9A6700', '#2563B8', '#7A3E9D', '#0F6E64', '#E8E8EC',
  '#6F7077', '#E5484D', '#2F9A6A', '#C69026', '#3B82C4', '#9A5FBF', '#1A9B8C', '#FFFFFF',
]

export interface TerminalPaintTheme {
  readonly foreground: string
  readonly background: string
  readonly cursor: string
  readonly ansi: readonly string[]
}

export function terminalPaintTheme(appearance: ResolvedTheme): TerminalPaintTheme {
  const dark = appearance === 'dark'
  return {
    foreground: dark ? '#E7E7E7' : '#1D1D20',
    background: dark ? '#0B0C0C' : '#F4F4F5',
    cursor: dark ? '#E7E7E7' : '#1D1D20',
    ansi: dark ? DARK_ANSI : LIGHT_ANSI,
  }
}

function indexedColor(index: number, ansi: readonly string[]): string {
  if (index < 16) return ansi[index] ?? ansi[7]!
  if (index < 232) {
    const value = index - 16
    const r = Math.floor(value / 36)
    const g = Math.floor((value % 36) / 6)
    const b = value % 6
    const level = (n: number) => (n === 0 ? 0 : 55 + n * 40)
    return '#' + [level(r), level(g), level(b)].map((n) => n.toString(16).padStart(2, '0')).join('')
  }
  const gray = 8 + (index - 232) * 10
  const hex = Math.max(0, Math.min(255, gray)).toString(16).padStart(2, '0')
  return '#' + hex + hex + hex
}

function resolveColor(color: TerminalColor, theme: TerminalPaintTheme, role: 'fg' | 'bg'): string {
  if (color.kind === 'default-fg') return theme.foreground
  if (color.kind === 'default-bg') return theme.background
  if (color.kind === 'rgb') {
    const hex = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
    return '#' + hex(color.r) + hex(color.g) + hex(color.b)
  }
  return indexedColor(color.index, theme.ansi) || (role === 'fg' ? theme.foreground : theme.background)
}

export interface TerminalRunStyle {
  text: string
  columns: number
  fill: boolean
  readonly color: string
  readonly backgroundColor: string
  readonly fontWeight?: number
  readonly fontStyle?: 'italic'
  readonly underline?: boolean
  readonly strike?: boolean
  readonly hidden?: boolean
}

export function isTerminalFillGlyph(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0
  return code >= 0x2588 && code <= 0x258f
}

export function paintTerminalCell(cell: TerminalCell, theme: TerminalPaintTheme): { color: string; backgroundColor: string; fontWeight?: number; fontStyle?: 'italic'; underline: boolean; strike: boolean; hidden: boolean } {
  let fg = resolveColor(cell.fg, theme, 'fg')
  let bg = resolveColor(cell.bg, theme, 'bg')
  if (cell.attrs & CELL_INVERSE) {
    const swap = fg
    fg = bg
    bg = swap
  }
  if (cell.attrs & CELL_DIM) fg = fg + '99'
  if (cell.attrs & CELL_HIDDEN) fg = bg
  return {
    color: fg,
    backgroundColor: bg,
    ...(cell.attrs & CELL_BOLD ? { fontWeight: 700 } : {}),
    ...(cell.attrs & CELL_ITALIC ? { fontStyle: 'italic' as const } : {}),
    underline: Boolean(cell.attrs & CELL_UNDERLINE),
    strike: Boolean(cell.attrs & CELL_STRIKE),
    hidden: Boolean(cell.attrs & CELL_HIDDEN),
  }
}

export function terminalRowRuns(cells: readonly TerminalCell[], theme: TerminalPaintTheme): TerminalRunStyle[] {
  const runs: TerminalRunStyle[] = []
  for (const cell of cells) {
    if (cell.attrs & CELL_SPACER) continue
    const painted = paintTerminalCell(cell, theme)
    const last = runs.at(-1)
    const ch = cell.ch || ' '
    const fill = isTerminalFillGlyph(ch)
    const columns = cell.attrs & CELL_WIDE ? 2 : 1
    const same = last
      && last.color === painted.color
      && last.backgroundColor === painted.backgroundColor
      && last.fontWeight === painted.fontWeight
      && last.fontStyle === painted.fontStyle
      && last.underline === painted.underline
      && last.strike === painted.strike
      && last.fill === fill
    if (same && last) {
      last.text += ch
      last.columns += columns
    } else {
      runs.push({
        text: ch,
        columns,
        fill,
        color: painted.color,
        backgroundColor: painted.backgroundColor,
        ...(painted.fontWeight ? { fontWeight: painted.fontWeight } : {}),
        ...(painted.fontStyle ? { fontStyle: painted.fontStyle } : {}),
        underline: painted.underline,
        strike: painted.strike,
        hidden: painted.hidden,
      })
    }
  }
  return runs
}
