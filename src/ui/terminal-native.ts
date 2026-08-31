import type { TerminalAppearance, TerminalGridSnapshot } from '../terminal/types.ts'
import { terminalRowRuns, type TerminalPaintTheme, type TerminalRunStyle } from './terminal-theme.ts'
import { TERMINAL_CELL_WIDTH, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT } from './terminal-metrics.ts'

export interface NativeTerminalStyle {
  readonly color: string
  readonly backgroundColor: string
  readonly fontFamily: string
  readonly fontWeight: number
  readonly italic: boolean
  readonly underline: boolean
  readonly strike: boolean
  readonly fill: boolean
}

export type NativeTerminalRun = readonly [
  row: number,
  column: number,
  columns: number,
  style: number,
  text: string,
]

export interface NativeTerminalFrame {
  readonly cols: number
  readonly rows: number
  readonly cellWidth: number
  readonly lineHeight: number
  readonly fontSize: number
  readonly background: string
  readonly cursorColor: string
  readonly cursorX: number
  readonly cursorY: number
  readonly cursorVisible: boolean
  readonly styles: readonly NativeTerminalStyle[]
  readonly runs: readonly NativeTerminalRun[]
}

export function terminalNativeFrame(
  snapshot: TerminalGridSnapshot,
  theme: TerminalPaintTheme,
  rendering: TerminalAppearance,
): NativeTerminalFrame {
  const styles: NativeTerminalStyle[] = []
  const styleIndexes = new Map<string, number>()
  const runs: NativeTerminalRun[] = []

  for (let rowIndex = 0; rowIndex < snapshot.viewport.length; rowIndex += 1) {
    const row = snapshot.viewport[rowIndex]!
    let column = 0
    for (const run of terminalRowRuns(row.cells, theme, rendering)) {
      const style = nativeStyle(run)
      const key = nativeStyleKey(style)
      let styleIndex = styleIndexes.get(key)
      if (styleIndex === undefined) {
        styleIndex = styles.length
        styles.push(style)
        styleIndexes.set(key, styleIndex)
      }
      runs.push([rowIndex, column, run.columns, styleIndex, run.text])
      column += run.columns
    }
  }

  return {
    cols: snapshot.cols,
    rows: snapshot.rows,
    cellWidth: TERMINAL_CELL_WIDTH,
    lineHeight: TERMINAL_LINE_HEIGHT,
    fontSize: TERMINAL_FONT_SIZE,
    background: theme.background,
    cursorColor: theme.cursor,
    cursorX: snapshot.cursorX,
    cursorY: snapshot.cursorY,
    cursorVisible: snapshot.cursorVisible,
    styles,
    runs,
  }
}

function nativeStyle(run: TerminalRunStyle): NativeTerminalStyle {
  return {
    color: run.color,
    backgroundColor: run.backgroundColor,
    fontFamily: run.fontFamily,
    fontWeight: run.fontWeight ?? 400,
    italic: run.fontStyle === 'italic',
    underline: Boolean(run.underline),
    strike: Boolean(run.strike),
    fill: run.fill,
  }
}

function nativeStyleKey(style: NativeTerminalStyle): string {
  return [
    style.color,
    style.backgroundColor,
    style.fontFamily,
    style.fontWeight,
    style.italic ? 1 : 0,
    style.underline ? 1 : 0,
    style.strike ? 1 : 0,
    style.fill ? 1 : 0,
  ].join('|')
}
