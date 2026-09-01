import React from 'react'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { TerminalOutputBuffer, type TerminalBackend, type TerminalOutputMetadata, type TerminalProcess } from '../src/terminal/backend.ts'
import type { TerminalProcessStatus, TerminalSpawnRequest } from '../src/terminal/types.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import {
  TERMINAL_CELL_WIDTH,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_PADDING_X,
  TERMINAL_PADDING_Y,
} from '../src/ui/terminal-metrics.ts'
import { TerminalView } from '../src/ui/terminal-view.tsx'

const ESC = '\x1b'
const COLS = positiveInteger(process.env.TERMINAL_BENCH_COLS, 160)
const ROWS = positiveInteger(process.env.TERMINAL_BENCH_ROWS, 50)
const SAMPLES = positiveInteger(process.env.TERMINAL_BENCH_SAMPLES, 20)
const REQUIRE_DIRECT = process.env.TERMINAL_BENCH_REQUIRE_DIRECT === '1'

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

const BLOCKS = ['▀', '▄', '█', '▌', '▐', '▖', '▗', '▘', '▙', '▛', '▜', '▝', '▟'] as const

class BufferedMemoryTerminalBackend implements TerminalBackend {
  #output: TerminalOutputBuffer | undefined
  #running = false

  emit(bytes: Uint8Array): void {
    if (!this.#running || !this.#output) return
    for (let offset = 0; offset < bytes.byteLength; offset += 1_024) {
      this.#output.write(bytes.subarray(offset, offset + 1_024))
    }
  }

  async spawn(_request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const dataListeners = new Set<(chunk: Uint8Array, metadata?: TerminalOutputMetadata) => void>()
    const output = new TerminalOutputBuffer((chunk, metadata) => {
      for (const listener of dataListeners) listener(chunk, metadata)
    })
    this.#output = output
    this.#running = true
    return {
      write: (data) => {
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
        this.emit(bytes)
      },
      resize() {},
      kill: () => {
        if (!this.#running) return
        this.#running = false
        output.close()
      },
      onData(listener) {
        dataListeners.add(listener)
        return () => { dataListeners.delete(listener) }
      },
      onExit(_listener: (status: TerminalProcessStatus) => void) { return () => {} },
    }
  }
}

function framebufferFrame(index: number): string {
  let output = ''
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS; column += 1) {
      const red = (column * 5 + index * 13) & 0xff
      const green = (row * 9 + column * 2 + index * 7) & 0xff
      const blue = (row * 3 + column * 7 + index * 11) & 0xff
      const background = (red + green + blue + 37) & 0xff
      const block = BLOCKS[(row + column + index) % BLOCKS.length]!
      output += `${ESC}[${row + 1};${column + 1}H${ESC}[38;2;${red};${green};${blue}m${ESC}[48;2;${background};${blue};${red}m${block}${ESC}[0m`
    }
  }
  return output
}

if (!hasNativeTestRenderer) {
  if (REQUIRE_DIRECT) throw new Error('@gpuix/native test renderer is required for the direct terminal benchmark')
  console.log('animated native frames   unavailable  @gpuix/native test renderer is not installed')
  process.exit(0)
}

const encoder = new TextEncoder()
const frames = Array.from(
  { length: SAMPLES + 3 },
  (_, index) => encoder.encode(`${ESC}[?2026h${framebufferFrame(index)}${ESC}[?2026l`),
)
const width = COLS * TERMINAL_CELL_WIDTH + TERMINAL_PADDING_X * 2
const height = ROWS * TERMINAL_LINE_HEIGHT + TERMINAL_PADDING_Y * 2
const backend = new BufferedMemoryTerminalBackend()
const service = new TerminalSessionService({
  cwd: '/tmp/heddlework-terminal-benchmark',
  backend,
  appearancePath: false,
})
const sessionId = await service.spawn({ cols: COLS, rows: ROWS })
const root = createTestRoot({ width: Math.ceil(width), height: Math.ceil(height) })
root.render(
  <TerminalView
    service={service}
    sessionId={sessionId}
    placement="bottom"
    width={width}
    height={height}
    appearance="dark"
  />,
)
root.renderer.flush()

const renderer = root.renderer as typeof root.renderer & {
  supportsNativeTerminal?: () => boolean
  setTerminalFrame?: (...args: unknown[]) => void
}
const native = renderer.supportsNativeTerminal?.() === true
const direct = typeof renderer.setTerminalFrame === 'function'
if (REQUIRE_DIRECT && (!native || !direct)) {
  root.unmount()
  await service.dispose()
  throw new Error('patched GPUIX native terminal with setTerminalFrame() is required')
}
for (let index = 0; index < 3; index += 1) {
  backend.emit(frames[index]!)
  root.renderer.flush()
}
root.renderer.resetDebugFrameOverlayStats()

const commits: number[] = []
const paints: number[] = []
const totals: number[] = []
for (let index = 0; index < SAMPLES; index += 1) {
  const startedAt = performance.now()
  backend.emit(frames[index + 3]!)
  const committedAt = performance.now()
  root.renderer.flush()
  const paintedAt = performance.now()
  commits.push(committedAt - startedAt)
  paints.push(paintedAt - committedAt)
  totals.push(paintedAt - startedAt)
}

const stats = root.renderer.getDebugFrameOverlayStats()
const retained = root.renderer.getRetainedElementCount()
console.log(`framebuffer median      ${percentile(totals, 0.5).toFixed(2).padStart(9)} ms  PTY fragments + per-cell cursor + truecolor + blocks at ${COLS}×${ROWS}`)
console.log(`framebuffer p95         ${percentile(totals, 0.95).toFixed(2).padStart(9)} ms  VT + React + NAPI + GPUI`)
console.log(`frame commit median     ${percentile(commits, 0.5).toFixed(2).padStart(9)} ms  parse + packed frame + native transport`)
console.log(`frame flush median      ${percentile(paints, 0.5).toFixed(2).padStart(9)} ms  GPUI layout and paint`)
console.log(`native paint p90        ${(stats.p90Ms ?? 0).toFixed(2).padStart(9)} ms  renderer frame instrumentation`)
console.log(`retained terminal nodes ${String(retained).padStart(9)}     ${native ? direct ? 'direct binary native surface' : 'base64 native surface' : 'React fallback'}`)

root.unmount()
await service.dispose()

if (native && retained > 5) throw new Error(`native terminal retained ${retained} nodes instead of one compact surface`)
