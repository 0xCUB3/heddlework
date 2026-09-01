import {
  CELL_BLINK,
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
  type TerminalGridSnapshot,
  type TerminalRow,
} from './types.ts'

const MAX_SCROLLBACK = 5_000
const DEFAULT_FG: TerminalColor = { kind: 'default-fg' }
const DEFAULT_BG: TerminalColor = { kind: 'default-bg' }

type ParserState = 'ground' | 'escape' | 'csi' | 'osc' | 'dcs' | 'charset'

interface MutableCell {
  ch: string
  fg: TerminalColor
  bg: TerminalColor
  attrs: number
}

function emptyCell(): MutableCell {
  return { ch: ' ', fg: DEFAULT_FG, bg: DEFAULT_BG, attrs: 0 }
}

function cloneCell(cell: MutableCell): MutableCell {
  return { ch: cell.ch, fg: cell.fg, bg: cell.bg, attrs: cell.attrs }
}

function blankRow(cols: number): MutableCell[] {
  return Array.from({ length: cols }, () => emptyCell())
}

function csiParam(params: readonly number[], index: number, fallback: number): number {
  const value = params[index] ?? 0
  return value === 0 ? fallback : value
}

function cellWidth(code: number): number {
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (code >= 0x300 && code <= 0x36f) return 0
  if (code >= 0x1ab0 && code <= 0x1aff) return 0
  if (code >= 0x20d0 && code <= 0x20ff) return 0
  if (code >= 0xfe00 && code <= 0xfe0f) return 0
  if (
    (code >= 0x1100 && code <= 0x115f)
    || code === 0x2329
    || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1f64f)
    || (code >= 0x1f900 && code <= 0x1f9ff)
    || (code >= 0x20000 && code <= 0x3fffd)
  ) return 2
  return 1
}

function cloneColor(color: TerminalColor): TerminalColor {
  if (color.kind === 'indexed') return { kind: 'indexed', index: color.index }
  if (color.kind === 'rgb') return { kind: 'rgb', r: color.r, g: color.g, b: color.b }
  return color
}

function freezeCell(cell: MutableCell): TerminalCell {
  return { ch: cell.ch, fg: cloneColor(cell.fg), bg: cloneColor(cell.bg), attrs: cell.attrs }
}

function rowText(row: readonly { ch: string; attrs: number }[]): string {
  let text = ''
  for (const cell of row) {
    if (cell.attrs & CELL_SPACER) continue
    text += cell.ch
  }
  return text.replace(/ +$/u, '')
}

export class VtEmulator {
  #cols: number
  #rows: number
  #screen: MutableCell[][]
  #alt: MutableCell[][] | undefined
  #scrollback: MutableCell[][] = []
  #x = 0
  #y = 0
  #savedX = 0
  #savedY = 0
  #altSavedX = 0
  #altSavedY = 0
  #scrollTop = 0
  #scrollBottom: number
  #wrap = true
  #wrapPending = false
  #origin = false
  #cursorVisible = true
  #applicationCursor = false
  #bracketedPaste = false
  #insert = false
  #title = ''
  #fg: TerminalColor = DEFAULT_FG
  #bg: TerminalColor = DEFAULT_BG
  #attrs = 0
  #state: ParserState = 'ground'
  #osc = ''
  #csiParams: number[] = []
  #csiValue = 0
  #csiHasValue = false
  #csiPrivate = false
  #utf8 = new TextDecoder('utf-8', { fatal: false })
  #synchronizedOutput = false
  #rowVersions = new WeakMap<MutableCell[], number>()
  #rowSnapshots = new WeakMap<MutableCell[], { cols: number; version: number; row: TerminalRow }>()
  #writeVersion = 0
  #lastTouchedRow: MutableCell[] | undefined
  #lastTouchedVersion = -1
  onOutput?: (data: string) => void

  constructor(cols = 80, rows = 24) {
    this.#cols = Math.max(2, cols)
    this.#rows = Math.max(1, rows)
    this.#screen = Array.from({ length: this.#rows }, () => blankRow(this.#cols))
    this.#scrollBottom = this.#rows - 1
  }

  get cols(): number {
    return this.#cols
  }

  get rows(): number {
    return this.#rows
  }

  get title(): string {
    return this.#title
  }

  get scrollbackLength(): number {
    return this.#scrollback.length
  }

  get applicationCursor(): boolean {
    return this.#applicationCursor
  }

  get bracketedPaste(): boolean {
    return this.#bracketedPaste
  }

  get synchronizedOutput(): boolean {
    return this.#synchronizedOutput
  }

  write(input: string | Uint8Array): void {
    const text = typeof input === 'string' ? input : this.#utf8.decode(input, { stream: true })
    this.#writeVersion += 1
    for (let index = 0; index < text.length;) {
      if (this.#state === 'ground'
        && text.charCodeAt(index) === 0x1b
        && text.charCodeAt(index + 1) === 0x5b) {
        const next = this.#fastCsi(text, index + 2)
        if (next !== -1) {
          index = next
          continue
        }
      }
      const code = text.codePointAt(index) ?? 0
      const length = code > 0xffff ? 2 : 1
      this.#feed(length === 1 ? text[index]! : text.slice(index, index + length))
      index += length
    }
  }

  resize(cols: number, rows: number): void {
    const nextCols = Math.max(2, Math.floor(cols))
    const nextRows = Math.max(1, Math.floor(rows))
    if (nextCols === this.#cols && nextRows === this.#rows) return
    this.#resizeBuffer(this.#screen, nextCols, nextRows)
    if (this.#alt) this.#resizeBuffer(this.#alt, nextCols, nextRows)
    this.#cols = nextCols
    this.#rows = nextRows
    this.#scrollTop = Math.min(this.#scrollTop, this.#rows - 1)
    this.#scrollBottom = this.#rows - 1
    this.#x = Math.min(this.#x, this.#cols - 1)
    this.#y = Math.min(this.#y, this.#rows - 1)
    this.#wrapPending = false
  }

  snapshot(scrollOffset = 0): TerminalGridSnapshot {
    const offset = Math.max(0, Math.min(this.#scrollback.length, Math.floor(scrollOffset)))
    const viewport: TerminalRow[] = []
    for (let row = 0; row < this.#rows; row += 1) {
      const sourceIndex = this.#scrollback.length - offset + row
      const source = sourceIndex < this.#scrollback.length
        ? this.#scrollback[sourceIndex]!
        : this.#screen[sourceIndex - this.#scrollback.length] ?? blankRow(this.#cols)
      viewport.push(this.#snapshotRow(source))
    }
    return {
      cols: this.#cols,
      rows: this.#rows,
      cursorX: this.#x,
      cursorY: this.#y,
      cursorVisible: this.#cursorVisible && offset === 0,
      applicationCursor: this.#applicationCursor,
      bracketedPaste: this.#bracketedPaste,
      title: this.#title,
      viewport,
      scrollback: this.#scrollback.length,
      scrollOffset: offset,
    }
  }

  #snapshotRow(source: MutableCell[]): TerminalRow {
    const version = this.#rowVersions.get(source) ?? 0
    const cached = this.#rowSnapshots.get(source)
    if (cached && cached.cols === this.#cols && cached.version === version) return cached.row
    const cells = source.slice(0, this.#cols).map((cell) => freezeCell(cell))
    while (cells.length < this.#cols) cells.push(freezeCell(emptyCell()))
    const row: TerminalRow = { cells, text: rowText(cells) }
    this.#rowSnapshots.set(source, { cols: this.#cols, version, row })
    return row
  }

  #resizeBuffer(buffer: MutableCell[][], cols: number, rows: number): void {
    for (const row of buffer) {
      if (row.length < cols) {
        while (row.length < cols) row.push(emptyCell())
      } else if (row.length > cols) {
        row.length = cols
      }
    }
    if (buffer.length < rows) {
      while (buffer.length < rows) buffer.push(blankRow(cols))
    } else if (buffer.length > rows) {
      buffer.length = rows
    }
  }

  #feed(char: string): void {
    const code = char.codePointAt(0) ?? 0
    if (this.#state === 'ground') {
      if (code === 0x1b) {
        this.#state = 'escape'
        return
      }
      this.#ground(char, code)
      return
    }
    if (this.#state === 'escape') {
      this.#escape(char, code)
      return
    }
    if (this.#state === 'csi') {
      if (code >= 0x30 && code <= 0x39) {
        this.#csiValue = this.#csiValue * 10 + code - 0x30
        this.#csiHasValue = true
      } else if (code === 0x3b || code === 0x3a) {
        this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        this.#csiValue = 0
        this.#csiHasValue = false
      } else if (code === 0x3f && this.#csiParams.length === 0 && !this.#csiHasValue) {
        this.#csiPrivate = true
      } else if (code >= 0x40 && code <= 0x7e) {
        if (this.#csiHasValue || this.#csiParams.length > 0) {
          this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        }
        this.#dispatchCsi(char, this.#csiParams, this.#csiPrivate)
        this.#resetCsi()
        this.#state = 'ground'
      }
      return
    }
    if (this.#state === 'osc') {
      if (char === '\u0007') {
        this.#dispatchOsc(this.#osc)
        this.#osc = ''
        this.#state = 'ground'
        return
      }
      if (this.#osc.endsWith('\u001b') && char === '\\') {
        this.#dispatchOsc(this.#osc.slice(0, -1))
        this.#osc = ''
        this.#state = 'ground'
        return
      }
      this.#osc += char
      if (this.#osc.length > 16_384) {
        this.#osc = ''
        this.#state = 'ground'
      }
      return
    }
    if (this.#state === 'charset') {
      this.#state = 'ground'
      return
    }
    if (char === '\u001b') {
      this.#state = 'escape'
      return
    }
    if (char === '\u0007') this.#state = 'ground'
  }

  #ground(char: string, code: number): void {
    if (code === 0 || code === 0x7f) return
    if (code === 0x07) return
    if (code === 0x08) {
      this.#wrapPending = false
      this.#x = Math.max(0, this.#x - 1)
      return
    }
    if (code === 0x09) {
      this.#wrapPending = false
      this.#x = Math.min(this.#cols - 1, this.#x + (8 - (this.#x % 8)))
      return
    }
    if (code === 0x0a || code === 0x0b || code === 0x0c) {
      this.#index()
      return
    }
    if (code === 0x0d) {
      this.#wrapPending = false
      this.#x = 0
      return
    }
    if (code < 32) return
    this.#print(char, code)
  }

  #escape(char: string, code: number): void {
    if (char === '[') {
      this.#state = 'csi'
      this.#resetCsi()
      return
    }
    if (char === ']') {
      this.#state = 'osc'
      this.#osc = ''
      return
    }
    if (char === 'P' || char === 'X' || char === '^' || char === '_') {
      this.#state = 'dcs'
      return
    }
    if (char === '(' || char === ')' || char === '*' || char === '+') {
      this.#state = 'charset'
      return
    }
    this.#state = 'ground'
    if (char === '7') {
      this.#savedX = this.#x
      this.#savedY = this.#y
      return
    }
    if (char === '8') {
      this.#x = this.#savedX
      this.#y = this.#savedY
      return
    }
    if (char === 'c') {
      this.#reset()
      return
    }
    if (char === 'D') {
      this.#index()
      return
    }
    if (char === 'E') {
      this.#x = 0
      this.#index()
      return
    }
    if (char === 'M') {
      this.#reverseIndex()
      return
    }
    if (code === 0x5c) return
  }

  #print(char: string, code: number): void {
    const width = code < 0x300 ? (code < 0x7f || code >= 0xa0 ? 1 : 0) : cellWidth(code)
    if (width === 0) {
      if (this.#x > 0) {
        const row = this.#screen[this.#y]!
        const cell = row[this.#x - 1]!
        if (!(cell.attrs & CELL_SPACER)) {
          cell.ch += char
          this.#touchRow(row)
        }
      }
      return
    }
    if (this.#wrapPending) {
      this.#index()
      this.#x = 0
      this.#wrapPending = false
    }
    if (this.#x + width > this.#cols) {
      if (this.#wrap) {
        this.#index()
        this.#x = 0
      } else {
        this.#x = Math.max(0, this.#cols - width)
      }
    }
    if (this.#insert) this.#insertBlanks(width)
    const row = this.#screen[this.#y]!
    const target = row[this.#x]!
    target.ch = char
    target.fg = this.#fg
    target.bg = this.#bg
    target.attrs = this.#attrs | (width === 2 ? CELL_WIDE : 0)
    if (width === 2 && this.#x + 1 < this.#cols) {
      const spacer = row[this.#x + 1]!
      spacer.ch = ' '
      spacer.fg = this.#fg
      spacer.bg = this.#bg
      spacer.attrs = this.#attrs | CELL_SPACER
    }
    this.#touchRow(row)
    this.#x += width
    if (this.#x >= this.#cols) {
      this.#x = this.#cols
      this.#wrapPending = this.#wrap
    }
  }

  #fastCsi(text: string, start: number): number {
    this.#resetCsi()
    for (let index = start; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code >= 0x30 && code <= 0x39) {
        this.#csiValue = this.#csiValue * 10 + code - 0x30
        this.#csiHasValue = true
      } else if (code === 0x3b || code === 0x3a) {
        this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        this.#csiValue = 0
        this.#csiHasValue = false
      } else if (code === 0x3f && this.#csiParams.length === 0 && !this.#csiHasValue) {
        this.#csiPrivate = true
      } else if (code >= 0x40 && code <= 0x7e) {
        if (this.#csiHasValue || this.#csiParams.length > 0) {
          this.#csiParams.push(this.#csiHasValue ? this.#csiValue : 0)
        }
        this.#dispatchCsi(text[index]!, this.#csiParams, this.#csiPrivate)
        this.#resetCsi()
        return index + 1
      }
    }
    this.#resetCsi()
    return -1
  }

  #resetCsi(): void {
    this.#csiParams.length = 0
    this.#csiValue = 0
    this.#csiHasValue = false
    this.#csiPrivate = false
  }

  #dispatchCsi(final: string, params: readonly number[], interrogate: boolean): void {
    if (final === 'A') {
      this.#wrapPending = false
      this.#y = Math.max(this.#scrollTop, this.#y - csiParam(params, 0, 1))
      return
    }
    if (final === 'B') {
      this.#wrapPending = false
      this.#y = Math.min(this.#scrollBottom, this.#y + csiParam(params, 0, 1))
      return
    }
    if (final === 'C') {
      this.#wrapPending = false
      this.#x = Math.min(this.#cols - 1, this.#x + csiParam(params, 0, 1))
      return
    }
    if (final === 'D') {
      this.#wrapPending = false
      this.#x = Math.max(0, this.#x - csiParam(params, 0, 1))
      return
    }
    if (final === 'E') {
      this.#x = 0
      this.#y = Math.min(this.#scrollBottom, this.#y + csiParam(params, 0, 1))
      return
    }
    if (final === 'F') {
      this.#x = 0
      this.#y = Math.max(this.#scrollTop, this.#y - csiParam(params, 0, 1))
      return
    }
    if (final === 'G' || final === '`') {
      this.#wrapPending = false
      this.#x = Math.max(0, Math.min(this.#cols - 1, csiParam(params, 0, 1) - 1))
      return
    }
    if (final === 'H' || final === 'f') {
      this.#wrapPending = false
      const row = csiParam(params, 0, 1) - 1
      const col = csiParam(params, 1, 1) - 1
      const origin = this.#origin ? this.#scrollTop : 0
      this.#y = Math.max(0, Math.min(this.#rows - 1, origin + row))
      this.#x = Math.max(0, Math.min(this.#cols - 1, col))
      return
    }
    if (final === 'J') this.#eraseDisplay(params[0] ?? 0)
    else if (final === 'K') this.#eraseLine(params[0] ?? 0)
    else if (final === 'L') this.#insertLines(csiParam(params, 0, 1))
    else if (final === 'M') this.#deleteLines(csiParam(params, 0, 1))
    else if (final === 'P') this.#deleteChars(csiParam(params, 0, 1))
    else if (final === '@') this.#insertBlanks(csiParam(params, 0, 1))
    else if (final === 'X') this.#eraseChars(csiParam(params, 0, 1))
    else if (final === 'S') this.#scrollUp(csiParam(params, 0, 1))
    else if (final === 'T') this.#scrollDown(csiParam(params, 0, 1))
    else if (final === 'd') this.#y = Math.max(0, Math.min(this.#rows - 1, csiParam(params, 0, 1) - 1))
    else if (final === 'm') this.#sgr(params)
    else if (final === 'n') this.#deviceStatus(params[0] ?? 0)
    else if (final === 'c') this.onOutput?.(String.fromCharCode(27) + '[?1;0c')
    else if (final === 'r') {
      const top = csiParam(params, 0, 1) - 1
      const bottom = (params[1] ? params[1] : this.#rows) - 1
      this.#scrollTop = Math.max(0, Math.min(this.#rows - 1, top))
      this.#scrollBottom = Math.max(this.#scrollTop, Math.min(this.#rows - 1, bottom))
      this.#x = 0
      this.#y = this.#origin ? this.#scrollTop : 0
    } else if (final === 'h' || final === 'l') {
      this.#setModes(params, interrogate, final === 'h')
    }
  }

  #dispatchOsc(body: string): void {
    const split = body.indexOf(';')
    const code = split === -1 ? body : body.slice(0, split)
    const value = split === -1 ? '' : body.slice(split + 1)
    if (code === '0' || code === '2' || code === '1') this.#title = value.replaceAll('\u0007', '')
  }

  #sgr(params: readonly number[]): void {
    if (params.length === 0) {
      this.#resetPen()
      return
    }
    for (let index = 0; index < params.length; index += 1) {
      const value = params[index] ?? 0
      if (value === 0) this.#resetPen()
      else if (value === 1) this.#attrs |= CELL_BOLD
      else if (value === 2) this.#attrs |= CELL_DIM
      else if (value === 3) this.#attrs |= CELL_ITALIC
      else if (value === 4) this.#attrs |= CELL_UNDERLINE
      else if (value === 5 || value === 6) this.#attrs |= CELL_BLINK
      else if (value === 7) this.#attrs |= CELL_INVERSE
      else if (value === 8) this.#attrs |= CELL_HIDDEN
      else if (value === 9) this.#attrs |= CELL_STRIKE
      else if (value === 21 || value === 22) this.#attrs &= ~(CELL_BOLD | CELL_DIM)
      else if (value === 23) this.#attrs &= ~CELL_ITALIC
      else if (value === 24) this.#attrs &= ~CELL_UNDERLINE
      else if (value === 25) this.#attrs &= ~CELL_BLINK
      else if (value === 27) this.#attrs &= ~CELL_INVERSE
      else if (value === 28) this.#attrs &= ~CELL_HIDDEN
      else if (value === 29) this.#attrs &= ~CELL_STRIKE
      else if (value === 39) this.#fg = DEFAULT_FG
      else if (value === 49) this.#bg = DEFAULT_BG
      else if (value >= 30 && value <= 37) this.#fg = { kind: 'indexed', index: value - 30 }
      else if (value >= 40 && value <= 47) this.#bg = { kind: 'indexed', index: value - 40 }
      else if (value >= 90 && value <= 97) this.#fg = { kind: 'indexed', index: value - 90 + 8 }
      else if (value >= 100 && value <= 107) this.#bg = { kind: 'indexed', index: value - 100 + 8 }
      else if (value === 38 || value === 48) {
        const target = this.#parseExtendedColor(params, index)
        if (target) {
          if (value === 38) this.#fg = target.color
          else this.#bg = target.color
          index = target.next
        }
      }
    }
  }

  #parseExtendedColor(params: readonly number[], index: number): { color: TerminalColor; next: number } | undefined {
    const mode = params[index + 1]
    if (mode === 5 && params[index + 2] !== undefined) {
      return { color: { kind: 'indexed', index: Math.max(0, Math.min(255, params[index + 2]!)) }, next: index + 2 }
    }
    if (mode === 2 && params[index + 4] !== undefined) {
      return {
        color: {
          kind: 'rgb',
          r: Math.max(0, Math.min(255, params[index + 2] ?? 0)),
          g: Math.max(0, Math.min(255, params[index + 3] ?? 0)),
          b: Math.max(0, Math.min(255, params[index + 4] ?? 0)),
        },
        next: index + 4,
      }
    }
    return undefined
  }

  #setModes(params: readonly number[], privateMode: boolean, enable: boolean): void {
    for (const param of params.length === 0 ? [0] : params) {
      if (!privateMode) {
        if (param === 4) this.#insert = enable
        continue
      }
      if (param === 1) this.#applicationCursor = enable
      else if (param === 6) this.#origin = enable
      else if (param === 7) this.#wrap = enable
      else if (param === 25) this.#cursorVisible = enable
      else if (param === 2004) this.#bracketedPaste = enable
      else if (param === 2026) this.#synchronizedOutput = enable
      else if (param === 47 || param === 1047) this.#setAltScreen(enable, false)
      else if (param === 1048) {
        if (enable) {
          this.#savedX = this.#x
          this.#savedY = this.#y
        } else {
          this.#x = this.#savedX
          this.#y = this.#savedY
        }
      } else if (param === 1049) this.#setAltScreen(enable, true)
    }
  }

  #setAltScreen(enable: boolean, saveCursor: boolean): void {
    if (enable) {
      if (saveCursor) {
        this.#altSavedX = this.#x
        this.#altSavedY = this.#y
      }
      if (!this.#alt) this.#alt = Array.from({ length: this.#rows }, () => blankRow(this.#cols))
      const current = this.#screen
      this.#screen = this.#alt
      this.#alt = current
      this.#eraseDisplay(2)
      this.#x = 0
      this.#y = 0
      return
    }
    if (!this.#alt) return
    const current = this.#screen
    this.#screen = this.#alt
    this.#alt = current
    if (saveCursor) {
      this.#x = this.#altSavedX
      this.#y = this.#altSavedY
    }
  }

  #deviceStatus(code: number): void {
    if (code === 5) this.onOutput?.(String.fromCharCode(27) + '[0n')
    if (code === 6) this.onOutput?.(String.fromCharCode(27) + '[' + String(this.#y + 1) + ';' + String(Math.min(this.#x, this.#cols - 1) + 1) + 'R')
  }

  #eraseCell(): MutableCell {
    return { ch: ' ', fg: this.#fg, bg: this.#bg, attrs: this.#attrs & ~(CELL_WIDE | CELL_SPACER) }
  }

  #applyErase(cell: MutableCell): void {
    cell.ch = ' '
    cell.fg = this.#fg
    cell.bg = this.#bg
    cell.attrs = this.#attrs & ~(CELL_WIDE | CELL_SPACER)
  }

  #eraseRow(): MutableCell[] {
    return Array.from({ length: this.#cols }, () => this.#eraseCell())
  }

  #eraseDisplay(mode: number): void {
    if (mode === 0) {
      this.#eraseLine(0)
      for (let row = this.#y + 1; row < this.#rows; row += 1) this.#screen[row] = this.#eraseRow()
    } else if (mode === 1) {
      for (let row = 0; row < this.#y; row += 1) this.#screen[row] = this.#eraseRow()
      this.#eraseLine(1)
    } else {
      this.#screen = Array.from({ length: this.#rows }, () => this.#eraseRow())
      if (mode === 3) this.#scrollback = []
    }
  }

  #eraseLine(mode: number): void {
    const row = this.#screen[this.#y]!
    const start = mode === 1 ? 0 : this.#x
    const end = mode === 1 ? this.#x : this.#cols - 1
    const from = mode === 2 ? 0 : start
    const to = mode === 2 ? this.#cols - 1 : end
    for (let col = from; col <= to; col += 1) this.#applyErase(row[col]!)
    this.#touchRow(row)
  }

  #eraseChars(count: number): void {
    const row = this.#screen[this.#y]!
    for (let index = 0; index < count && this.#x + index < this.#cols; index += 1) this.#applyErase(row[this.#x + index]!)
    this.#touchRow(row)
  }

  #insertBlanks(count: number): void {
    const row = this.#screen[this.#y]!
    for (let index = 0; index < count; index += 1) row.splice(this.#x, 0, this.#eraseCell())
    row.length = this.#cols
    this.#touchRow(row)
  }

  #deleteChars(count: number): void {
    const row = this.#screen[this.#y]!
    row.splice(this.#x, count)
    while (row.length < this.#cols) row.push(this.#eraseCell())
    this.#touchRow(row)
  }

  #insertLines(count: number): void {
    for (let index = 0; index < count; index += 1) this.#screen.splice(this.#y, 0, this.#eraseRow())
    this.#screen.splice(this.#scrollBottom + 1, count)
    this.#screen.length = this.#rows
  }

  #deleteLines(count: number): void {
    this.#screen.splice(this.#y, count)
    while (this.#screen.length < this.#rows) {
      this.#screen.splice(this.#scrollBottom + 1 - (this.#rows - this.#screen.length), 0, this.#eraseRow())
    }
    this.#screen.length = this.#rows
  }

  #scrollUp(count: number): void {
    for (let index = 0; index < count; index += 1) {
      const removed = this.#screen.splice(this.#scrollTop, 1)[0] ?? this.#eraseRow()
      if (this.#scrollTop === 0 && !this.#alt) this.#pushScrollback(removed)
      this.#screen.splice(this.#scrollBottom, 0, this.#eraseRow())
    }
    this.#screen.length = this.#rows
  }

  #scrollDown(count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.#screen.splice(this.#scrollBottom + 1, 1)
      this.#screen.splice(this.#scrollTop, 0, this.#eraseRow())
    }
    this.#screen.length = this.#rows
  }

  #index(): void {
    this.#wrapPending = false
    if (this.#y === this.#scrollBottom) this.#scrollUp(1)
    else if (this.#y < this.#rows - 1) this.#y += 1
  }

  #reverseIndex(): void {
    this.#wrapPending = false
    if (this.#y === this.#scrollTop) this.#scrollDown(1)
    else if (this.#y > 0) this.#y -= 1
  }

  #pushScrollback(row: MutableCell[]): void {
    this.#scrollback.push(row.map((cell) => cloneCell(cell)))
    if (this.#scrollback.length > MAX_SCROLLBACK) this.#scrollback.splice(0, this.#scrollback.length - MAX_SCROLLBACK)
  }

  #touchRow(row: MutableCell[]): void {
    if (this.#lastTouchedRow === row && this.#lastTouchedVersion === this.#writeVersion) return
    this.#rowVersions.set(row, this.#writeVersion)
    this.#lastTouchedRow = row
    this.#lastTouchedVersion = this.#writeVersion
  }

  #resetPen(): void {
    this.#fg = DEFAULT_FG
    this.#bg = DEFAULT_BG
    this.#attrs = 0
  }

  #reset(): void {
    this.#screen = Array.from({ length: this.#rows }, () => blankRow(this.#cols))
    this.#alt = undefined
    this.#x = 0
    this.#y = 0
    this.#scrollTop = 0
    this.#scrollBottom = this.#rows - 1
    this.#wrap = true
    this.#wrapPending = false
    this.#origin = false
    this.#cursorVisible = true
    this.#applicationCursor = false
    this.#bracketedPaste = false
    this.#synchronizedOutput = false
    this.#insert = false
    this.#resetPen()
    this.#state = 'ground'
  }
}
