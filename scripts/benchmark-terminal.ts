import { TerminalOutputBuffer } from '../src/terminal/backend.ts'
import { VtEmulator } from '../src/terminal/vt.ts'
import { terminalPaintTheme, terminalRowRuns } from '../src/ui/terminal-theme.ts'

const ESC = '\x1b'

interface Measurement {
  readonly name: string
  readonly milliseconds: number
  readonly detail: string
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]!
}

function measure(name: string, detail: string, operation: () => void): Measurement {
  operation()
  const samples: number[] = []
  for (let sample = 0; sample < 3; sample += 1) {
    const startedAt = performance.now()
    operation()
    samples.push(performance.now() - startedAt)
  }
  return { name, milliseconds: median(samples), detail }
}

const measurements: Measurement[] = []
const frameCell = `${ESC}[24;80H${ESC}[38;2;255;80;120m${ESC}[48;2;21;9;30m▙${ESC}[0m`
const frameBody = frameCell.repeat(Math.ceil(500 * 1024 / frameCell.length))
const fragmentedFrame = new TextEncoder().encode(`${ESC}[?2026h${frameBody}${ESC}[?2026l`)
let deliveredFrames = 0
function coalesceFragmentedFrame(): void {
  const output = new TerminalOutputBuffer(() => { deliveredFrames += 1 })
  for (let offset = 0; offset < fragmentedFrame.byteLength; offset += 1_024) {
    output.write(fragmentedFrame.subarray(offset, offset + 1_024))
  }
  output.close()
}
for (let warmup = 0; warmup < 5; warmup += 1) coalesceFragmentedFrame()
deliveredFrames = 0
let reusedRows = 0
let comparedRows = 0
measurements.push(measure(
  'frame coalescing',
  `${Math.round(fragmentedFrame.byteLength / 1024)} KiB DEC frame in 1 KiB PTY fragments`,
  coalesceFragmentedFrame,
))

measurements.push(measure('incremental snapshots', '2,000 writes and snapshots at 160×50', () => {
  const vt = new VtEmulator(160, 50)
  let previous = vt.snapshot()
  for (let index = 0; index < 2_000; index += 1) {
    vt.write(`${ESC}[${index % 50 + 1};${index % 150 + 1}H${String.fromCharCode(33 + index % 80)}`)
    const next = vt.snapshot()
    for (let row = 0; row < next.rows; row += 1) {
      comparedRows += 1
      if (next.viewport[row] === previous.viewport[row]) reusedRows += 1
    }
    previous = next
  }
}))

measurements.push(measure('stream parse', '5 MiB ANSI stream and one 160×50 snapshot', () => {
  const vt = new VtEmulator(160, 50)
  const line = `${ESC}[38;2;82;169;255mhello world ${ESC}[0m${'x'.repeat(100)}\r\n`
  const stream = line.repeat(Math.ceil(5 * 1024 * 1024 / line.length))
  vt.write(stream)
  vt.snapshot()
}))

measurements.push(measure('row projections', '1,000 full 160×50 style projections', () => {
  const vt = new VtEmulator(160, 50)
  vt.write(`${ESC}[31mred${ESC}[0m plain ${ESC}[1;34mbold${ESC}[0m\r\n`.repeat(50))
  const snapshot = vt.snapshot()
  const theme = terminalPaintTheme('dark')
  for (let iteration = 0; iteration < 1_000; iteration += 1) {
    for (const row of snapshot.viewport) terminalRowRuns(row.cells, theme)
  }
}))

if (deliveredFrames !== 4) throw new Error(`terminal frame coalescer delivered ${deliveredFrames} frames instead of 4`)

for (const measurement of measurements) {
  console.log(`${measurement.name.padEnd(23)} ${measurement.milliseconds.toFixed(2).padStart(9)} ms  ${measurement.detail}`)
}
const reusePercent = comparedRows === 0 ? 0 : reusedRows / comparedRows * 100
console.log(`row identity reuse       ${reusePercent.toFixed(2).padStart(9)} %  unchanged rows skip React reconciliation`)
if (reusePercent < 95) throw new Error(`terminal row identity reuse regressed to ${reusePercent.toFixed(2)}%`)
