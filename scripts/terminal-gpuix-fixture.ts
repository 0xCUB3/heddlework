export {}

const ESC = '\x1b'
const GLYPHS = [' ', '▀', '▄', '█', '▌', '▐', '▖', '▗', '▘', '▙', '▛', '▜', '▝', '▟'] as const
const fps = positiveNumber(process.env.HEDDLEWORK_TERMINAL_FIXTURE_FPS, 60)
const periodMs = 1_000 / fps
let frames: readonly Buffer[] = []
let frameIndex = 0
let timer: ReturnType<typeof setTimeout> | undefined
let writable = true
let stopped = false
let lastCols = 0
let lastRows = 0

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function dimensions(): { cols: number; rows: number } {
  const output = process.stdout as NodeJS.WriteStream
  const cols = Math.max(2, output.columns ?? (Number(process.env.COLUMNS) || 160))
  const rows = Math.max(1, output.rows ?? (Number(process.env.LINES) || 50))
  return { cols, rows }
}

function createFrame(cols: number, rows: number, index: number): Buffer {
  const parts: string[] = [`${ESC}[?2026h${ESC}[?25l`]
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < cols; column += 1) {
      const red = (column * 5 + index * 13) & 0xff
      const green = (row * 9 + column * 2 + index * 7) & 0xff
      const blue = (row * 3 + column * 7 + index * 11) & 0xff
      const background = (red + green + blue + 37) & 0xff
      const glyph = GLYPHS[(row + column + index) % GLYPHS.length]!
      parts.push(
        `${ESC}[${row + 1};${column + 1}H` +
        `${ESC}[38;2;${red};${green};${blue}m` +
        `${ESC}[48;2;${background};${blue};${red}m${glyph}${ESC}[0m`,
      )
    }
  }
  parts.push(`${ESC}[?2026l`)
  return Buffer.from(parts.join(''))
}

function rebuildFrames(): void {
  const { cols, rows } = dimensions()
  if (cols === lastCols && rows === lastRows && frames.length > 0) return
  lastCols = cols
  lastRows = rows
  frames = Array.from({ length: 4 }, (_, index) => createFrame(cols, rows, index))
  frameIndex = 0
}

function scheduleRebuild(): void {
  setTimeout(rebuildFrames, 25)
}

function draw(): void {
  if (stopped) return
  const startedAt = performance.now()
  rebuildFrames()
  if (writable && frames.length > 0) {
    writable = process.stdout.write(frames[frameIndex % frames.length]!)
    frameIndex += 1
  }
  timer = setTimeout(draw, Math.max(0, periodMs - (performance.now() - startedAt)))
}

function stop(exitCode = 0): void {
  if (stopped) return
  stopped = true
  if (timer) clearTimeout(timer)
  process.stdout.write(`${ESC}[0m${ESC}[?25h`)
  setTimeout(() => process.exit(exitCode), 0)
}

process.stdout.on('drain', () => { writable = true })
process.stdout.on('resize', scheduleRebuild)
process.on('SIGWINCH', scheduleRebuild)
process.once('SIGINT', () => stop(130))
process.once('SIGTERM', () => stop(143))
process.once('SIGHUP', () => stop(129))

process.stdout.write(`${ESC}]0;GPUIX terminal framebuffer fixture\x07${ESC}[2J`)
rebuildFrames()
timer = setTimeout(draw, 100)
