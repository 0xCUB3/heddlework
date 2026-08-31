import React from 'react'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import {
  TERMINAL_CELL_WIDTH,
  TERMINAL_LINE_HEIGHT,
  TERMINAL_PADDING_X,
  TERMINAL_PADDING_Y,
} from '../src/ui/terminal-metrics.ts'
import { TerminalView } from '../src/ui/terminal-view.tsx'

const ESC = '\x1b'
const COLS = 160
const ROWS = 50
const SAMPLES = 20

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]!
}

function animatedFrame(index: number): string {
  let output = `${ESC}[H`
  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLS; column += 4) {
      const color = 31 + ((column / 4 + row + index) % 7)
      const character = String.fromCharCode(65 + ((column + row + index) % 26))
      output += `${ESC}[${color}m${character.repeat(4)}`
    }
    if (row < ROWS - 1) output += '\r\n'
  }
  return output + `${ESC}[0m`
}

if (!hasNativeTestRenderer) {
  console.log('animated native frames   unavailable  @gpuix/native test renderer is not installed')
  process.exit(0)
}

const width = COLS * TERMINAL_CELL_WIDTH + TERMINAL_PADDING_X * 2
const height = ROWS * TERMINAL_LINE_HEIGHT + TERMINAL_PADDING_Y * 2
const service = new TerminalSessionService({
  cwd: '/tmp/heddlework-terminal-benchmark',
  backend: new MemoryTerminalBackend(),
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

const renderer = root.renderer as typeof root.renderer & { supportsNativeTerminal?: () => boolean }
const native = renderer.supportsNativeTerminal?.() === true
for (let index = 0; index < 3; index += 1) {
  service.write(sessionId, `${ESC}[?2026h`)
  service.write(sessionId, animatedFrame(index))
  service.write(sessionId, `${ESC}[?2026l`)
  root.renderer.flush()
}
root.renderer.resetDebugFrameOverlayStats()

const commits: number[] = []
const paints: number[] = []
const totals: number[] = []
for (let index = 0; index < SAMPLES; index += 1) {
  const startedAt = performance.now()
  service.write(sessionId, `${ESC}[?2026h`)
  service.write(sessionId, animatedFrame(index + 3))
  service.write(sessionId, `${ESC}[?2026l`)
  const committedAt = performance.now()
  root.renderer.flush()
  const paintedAt = performance.now()
  commits.push(committedAt - startedAt)
  paints.push(paintedAt - committedAt)
  totals.push(paintedAt - startedAt)
}

const stats = root.renderer.getDebugFrameOverlayStats()
const retained = root.renderer.getRetainedElementCount()
console.log(`animated frame median   ${percentile(totals, 0.5).toFixed(2).padStart(9)} ms  VT + React + NAPI + GPUI at ${COLS}×${ROWS}`)
console.log(`animated frame p95      ${percentile(totals, 0.95).toFixed(2).padStart(9)} ms  high-churn colored TUI`)
console.log(`frame commit median     ${percentile(commits, 0.5).toFixed(2).padStart(9)} ms  parse + packed frame + native mutation`)
console.log(`frame flush median      ${percentile(paints, 0.5).toFixed(2).padStart(9)} ms  GPUI layout and paint`)
console.log(`native paint p90        ${(stats.p90Ms ?? 0).toFixed(2).padStart(9)} ms  renderer frame instrumentation`)
console.log(`retained terminal nodes ${String(retained).padStart(9)}     ${native ? 'single native surface' : 'React fallback'}`)

root.unmount()
await service.dispose()

if (native && retained > 5) throw new Error(`native terminal retained ${retained} nodes instead of one compact surface`)
