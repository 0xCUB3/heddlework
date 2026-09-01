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
  TERMINAL_PACKED_CELL_WORDS,
  TERMINAL_PACKED_COLOR_DEFAULT_BG,
  TERMINAL_PACKED_COLOR_DEFAULT_FG,
  TERMINAL_PACKED_COLOR_INDEXED,
  TERMINAL_PACKED_COLOR_KIND_MASK,
  type TerminalAppearance,
  type TerminalCell,
  type TerminalGridSnapshot,
} from '../terminal/types.ts'
import {
  isNerdFontCodepoint,
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

export interface NativeTerminalFrameMetadata {
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
  readonly graphemes: readonly string[]
}

export interface NativeTerminalFrame extends NativeTerminalFrameMetadata {
  readonly cells: string
}

export interface NativeTerminalBinaryFrame extends NativeTerminalFrameMetadata {
  readonly cells: Uint8Array
}

export function terminalNativeFrame(
  snapshot: TerminalGridSnapshot,
  theme: TerminalPaintTheme,
  rendering: TerminalAppearance,
): NativeTerminalFrame {
  const frame = terminalNativeBinaryFrame(snapshot, theme, rendering)
  return { ...frame, cells: encodeBase64(frame.cells) }
}

export function terminalNativeBinaryFrame(
  snapshot: TerminalGridSnapshot,
  theme: TerminalPaintTheme,
  rendering: TerminalAppearance,
): NativeTerminalBinaryFrame {
  const bytes = new Uint8Array(snapshot.cols * snapshot.rows * NATIVE_TERMINAL_CELL_BYTES)
  const view = new DataView(bytes.buffer)
  const graphemes: string[] = []
  const graphemeIndexes = new Map<string, number>()
  const ansi = theme.ansi.map(packedCssColor)
  const defaultForeground = packedCssColor(theme.foreground)
  const defaultBackground = packedCssColor(theme.background)
  let offset = 0

  for (let rowIndex = 0; rowIndex < snapshot.rows; rowIndex += 1) {
    const packedRow = snapshot.packedViewport?.[rowIndex]
    const row = packedRow ? undefined : snapshot.viewport[rowIndex]
    for (let column = 0; column < snapshot.cols; column += 1) {
      const word = column * TERMINAL_PACKED_CELL_WORDS
      const cell = packedRow ? undefined : row?.cells[column] ?? blankCell()
      const codepoint = packedRow ? packedRow.cells[word] ?? 32 : cell!.ch.codePointAt(0) ?? 32
      const attrs = packedRow ? packedRow.cells[word + 3] ?? 0 : cell!.attrs
      const packedForeground = packedRow ? packedRow.cells[word + 1] ?? TERMINAL_PACKED_COLOR_DEFAULT_FG : 0
      const packedBackground = packedRow ? packedRow.cells[word + 2] ?? TERMINAL_PACKED_COLOR_DEFAULT_BG : 0
      let raw = packedRow?.graphemes?.get(column) ?? (cell ? cell.ch || ' ' : undefined)
      const spacer = Boolean(attrs & CELL_SPACER)
      let glyph = spacer ? 0 : codepoint
      if (!spacer && raw !== undefined) {
        const text = rendering.muteEmojiColors && raw.charCodeAt(0) >= 0x80
          ? muteEmojiPresentation(raw)
          : raw
        glyph = packedGlyph(text, graphemes, graphemeIndexes)
      } else if (!spacer
        && rendering.muteEmojiColors
        && codepoint >= 0x80
        && (codepoint < 0x2580 || codepoint > 0x259f)) {
        raw = String.fromCodePoint(codepoint)
        const text = muteEmojiPresentation(raw)
        if (text !== raw) glyph = packedGlyph(text, graphemes, graphemeIndexes)
      }

      let foreground: number
      let background: number
      if (theme.minimumContrastRatio === 1 && !(attrs & CELL_DIM)) {
        foreground = packedRow
          ? packedRawTerminalColor(packedForeground, ansi, defaultForeground, defaultBackground, true, Boolean(attrs & CELL_BOLD))
          : packedTerminalColor(cell!.fg, ansi, defaultForeground, defaultBackground, true, Boolean(attrs & CELL_BOLD))
        background = packedRow
          ? packedRawTerminalColor(packedBackground, ansi, defaultForeground, defaultBackground, false, false)
          : packedTerminalColor(cell!.bg, ansi, defaultForeground, defaultBackground, false, false)
        if (attrs & CELL_INVERSE) [foreground, background] = [background, foreground]
        if (attrs & CELL_HIDDEN) foreground = background
      } else {
        const paintCell = cell ?? {
          ch: raw ?? String.fromCodePoint(codepoint),
          fg: unpackRawTerminalColor(packedForeground),
          bg: unpackRawTerminalColor(packedBackground),
          attrs,
        }
        const painted = paintTerminalCell(paintCell, theme)
        foreground = packedCssColor(painted.color)
        background = packedCssColor(painted.backgroundColor)
      }
      let flags = 0
      if (attrs & CELL_WIDE) flags |= NATIVE_CELL_WIDE
      if (spacer) flags |= NATIVE_CELL_SPACER
      if (attrs & CELL_BOLD) flags |= NATIVE_CELL_BOLD
      if (attrs & CELL_ITALIC) flags |= NATIVE_CELL_ITALIC
      if (attrs & CELL_UNDERLINE) flags |= NATIVE_CELL_UNDERLINE
      if (attrs & CELL_STRIKE) flags |= NATIVE_CELL_STRIKE
      if (packedRow ? codepoint === 0x2588 : isTerminalFillGlyph(raw!)) flags |= NATIVE_CELL_FILL
      if (rendering.nerdFontEnabled
        && (raw === undefined ? isNerdFontCodepoint(codepoint) : isNerdFontGlyph(raw))) flags |= NATIVE_CELL_NERD_FONT

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
    cells: bytes,
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

function packedRawTerminalColor(
  color: number,
  ansi: readonly number[],
  defaultForeground: number,
  defaultBackground: number,
  foreground: boolean,
  bold: boolean,
): number {
  const kind = color & TERMINAL_PACKED_COLOR_KIND_MASK
  if (kind === TERMINAL_PACKED_COLOR_DEFAULT_FG) return defaultForeground
  if (kind === TERMINAL_PACKED_COLOR_DEFAULT_BG) return defaultBackground
  if (kind === TERMINAL_PACKED_COLOR_INDEXED) {
    const rawIndex = color & 0xff
    const index = foreground && bold && rawIndex < 8 ? rawIndex + 8 : rawIndex
    return ansi[index] ?? ansi[7] ?? 0xffffff
  }
  return color & 0xffffff
}

function unpackRawTerminalColor(color: number): TerminalCell['fg'] {
  const kind = color & TERMINAL_PACKED_COLOR_KIND_MASK
  if (kind === TERMINAL_PACKED_COLOR_DEFAULT_FG) return { kind: 'default-fg' }
  if (kind === TERMINAL_PACKED_COLOR_DEFAULT_BG) return { kind: 'default-bg' }
  if (kind === TERMINAL_PACKED_COLOR_INDEXED) return { kind: 'indexed', index: color & 0xff }
  return { kind: 'rgb', r: (color >>> 16) & 0xff, g: (color >>> 8) & 0xff, b: color & 0xff }
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
