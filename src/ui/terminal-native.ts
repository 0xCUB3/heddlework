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
  type TerminalAppearance,
  type TerminalCell,
  type TerminalGridSnapshot,
} from '../terminal/types.ts'
import {
  isNerdFontGlyph,
  isTerminalFillGlyph,
  muteEmojiPresentation,
  paintTerminalCell,
  type TerminalPaintTheme,
} from './terminal-theme.ts'
import { TERMINAL_CELL_WIDTH, TERMINAL_FONT_SIZE, TERMINAL_LINE_HEIGHT } from './terminal-metrics.ts'

export const NATIVE_TERMINAL_CELL_BYTES = 16
export const NATIVE_CELL_WIDE = 1 << 0
export const NATIVE_CELL_SPACER = 1 << 1
export const NATIVE_CELL_BOLD = 1 << 2
export const NATIVE_CELL_ITALIC = 1 << 3
export const NATIVE_CELL_UNDERLINE = 1 << 4
export const NATIVE_CELL_STRIKE = 1 << 5
export const NATIVE_CELL_FILL = 1 << 6
export const NATIVE_CELL_NERD_FONT = 1 << 7
const NATIVE_GRAPHEME_INDEX = 0x80000000

export interface NativeTerminalFrame {
  readonly version: 2
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
  readonly fontFamily: string
  readonly nerdFontFamily: string
  readonly ligaturesEnabled: boolean
  readonly cells: string
  readonly graphemes: readonly string[]
}

export function terminalNativeFrame(
  snapshot: TerminalGridSnapshot,
  theme: TerminalPaintTheme,
  rendering: TerminalAppearance,
): NativeTerminalFrame {
  const bytes = new Uint8Array(snapshot.cols * snapshot.rows * NATIVE_TERMINAL_CELL_BYTES)
  const view = new DataView(bytes.buffer)
  const graphemes: string[] = []
  const graphemeIndexes = new Map<string, number>()
  const ansi = theme.ansi.map(packedCssColor)
  const defaultForeground = packedCssColor(theme.foreground)
  const defaultBackground = packedCssColor(theme.background)
  let offset = 0

  for (let rowIndex = 0; rowIndex < snapshot.rows; rowIndex += 1) {
    const row = snapshot.viewport[rowIndex]
    for (let column = 0; column < snapshot.cols; column += 1) {
      const cell = row?.cells[column] ?? blankCell()
      const raw = cell.ch || ' '
      const text = rendering.muteEmojiColors && raw.charCodeAt(0) >= 0x80
        ? muteEmojiPresentation(raw)
        : raw
      const spacer = Boolean(cell.attrs & CELL_SPACER)
      const glyph = spacer ? 0 : packedGlyph(text, graphemes, graphemeIndexes)
      let foreground: number
      let background: number
      if (theme.minimumContrastRatio === 1 && !(cell.attrs & CELL_DIM)) {
        foreground = packedTerminalColor(cell.fg, ansi, defaultForeground, defaultBackground, true, Boolean(cell.attrs & CELL_BOLD))
        background = packedTerminalColor(cell.bg, ansi, defaultForeground, defaultBackground, false, false)
        if (cell.attrs & CELL_INVERSE) [foreground, background] = [background, foreground]
        if (cell.attrs & CELL_HIDDEN) foreground = background
      } else {
        const painted = paintTerminalCell(cell, theme)
        foreground = packedCssColor(painted.color)
        background = packedCssColor(painted.backgroundColor)
      }
      let flags = 0
      if (cell.attrs & CELL_WIDE) flags |= NATIVE_CELL_WIDE
      if (spacer) flags |= NATIVE_CELL_SPACER
      if (cell.attrs & CELL_BOLD) flags |= NATIVE_CELL_BOLD
      if (cell.attrs & CELL_ITALIC) flags |= NATIVE_CELL_ITALIC
      if (cell.attrs & CELL_UNDERLINE) flags |= NATIVE_CELL_UNDERLINE
      if (cell.attrs & CELL_STRIKE) flags |= NATIVE_CELL_STRIKE
      if (isTerminalFillGlyph(raw)) flags |= NATIVE_CELL_FILL
      if (rendering.nerdFontEnabled && isNerdFontGlyph(raw)) flags |= NATIVE_CELL_NERD_FONT

      view.setUint32(offset, glyph, true)
      view.setUint32(offset + 4, foreground, true)
      view.setUint32(offset + 8, background, true)
      view.setUint16(offset + 12, flags, true)
      offset += NATIVE_TERMINAL_CELL_BYTES
    }
  }

  return {
    version: 2,
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
    fontFamily: rendering.fontFamily,
    nerdFontFamily: rendering.nerdFontFamily,
    ligaturesEnabled: rendering.ligaturesEnabled,
    cells: encodeBase64(bytes),
    graphemes,
  }
}

const BLANK_CELL: TerminalCell = {
  ch: ' ',
  fg: { kind: 'default-fg' },
  bg: { kind: 'default-bg' },
  attrs: 0,
}

function blankCell(): TerminalCell {
  return BLANK_CELL
}

function packedGlyph(
  text: string,
  graphemes: string[],
  indexes: Map<string, number>,
): number {
  if (text.length === 1) return text.charCodeAt(0)
  const codepoint = text.codePointAt(0) ?? 32
  if (text.length === 2 && codepoint > 0xffff) return codepoint
  let index = indexes.get(text)
  if (index === undefined) {
    index = graphemes.length
    graphemes.push(text)
    indexes.set(text, index)
  }
  return NATIVE_GRAPHEME_INDEX | index
}

function packedTerminalColor(
  color: TerminalCell['fg'],
  ansi: readonly number[],
  defaultForeground: number,
  defaultBackground: number,
  foreground: boolean,
  bold: boolean,
): number {
  if (color.kind === 'default-fg') return defaultForeground
  if (color.kind === 'default-bg') return defaultBackground
  if (color.kind === 'rgb') return (color.r << 16) | (color.g << 8) | color.b
  const index = foreground && bold && color.index < 8 ? color.index + 8 : color.index
  return ansi[Math.max(0, Math.min(255, index))] ?? ansi[7] ?? 0xffffff
}

function packedCssColor(color: string): number {
  const start = color.charCodeAt(0) === 35 ? 1 : 0
  let packed = 0
  for (let index = start; index < Math.min(color.length, start + 6); index += 1) {
    const code = color.charCodeAt(index)
    const nibble = code >= 97 ? code - 87 : code >= 65 ? code - 55 : code - 48
    packed = (packed << 4) | Math.max(0, Math.min(15, nibble))
  }
  return packed
}

function encodeBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return btoa(binary)
}
