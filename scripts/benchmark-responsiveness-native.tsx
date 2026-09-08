import React from 'react'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { createInitialState, type WorkbenchState } from '../src/workbench/state.ts'
import type { PiMessage } from '../src/pi/types.ts'
import { Transcript } from '../src/ui/transcript.tsx'

// Uses GPUix's offscreen test window, never the user's running app.
if (!hasNativeTestRenderer) throw new Error('GPUix native test renderer is unavailable')
const noop = () => {}
const presenters = new Map()
const results: Record<string, unknown>[] = []
function summary(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return { medianMs: +sorted[Math.floor(sorted.length / 2)]!.toFixed(2), p95Ms: +sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)]!.toFixed(2), maxMs: +sorted.at(-1)!.toFixed(2) }
}
function messages(turns: number, rich: boolean): PiMessage[] {
  const detail = rich ? '\n\n## Findings\n\n' + ('A paragraph with **important text**, `identifiers`, and a [reference](https://example.com).\n\n- First finding\n- Second finding\n\n```ts\nconst value = 42\nconsole.log(value)\n```\n\n').repeat(8) : ''
  return Array.from({ length: turns }, (_, index): PiMessage[] => [
    { role: 'user', workbenchEntryId: `u${index}`, content: `Prompt ${index}`, timestamp: index * 2 },
    { role: 'assistant', workbenchEntryId: `a${index}`, content: `Answer ${index}${detail}`, timestamp: index * 2 + 1 },
  ]).flat()
}
for (const [turns, rich] of [[40, false], [160, false], [1000, false], [40, true], [160, true]] as const) {
  const root = createTestRoot({ width: 900, height: 640 })
  let state: WorkbenchState = { ...createInitialState('/tmp/responsiveness-native'), messages: messages(turns, rich) }
  const render = () => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={presenters} onOpenDiff={noop} onRevert={noop} onDismissNotice={noop} /></div>)
  try {
    let started = performance.now()
    render()
    const mountMs = performance.now() - started
    await Bun.sleep(550)
    root.renderer.flush()
    const tailPainted = root.renderer.getPaintedText().includes(`Answer ${turns - 1}`)
    if (!tailPainted) throw new Error(`Tail did not paint: ${turns}, rich=${rich}`)
    const unrelated: number[] = []
    const streamed: number[] = []
    for (let index = 0; index < 20; index++) {
      state = { ...state, editorText: `draft ${index}` }
      started = performance.now()
      render()
      unrelated.push(performance.now() - started)
    }
    for (let index = 1; index <= 20; index++) {
      state = { ...state, session: { ...state.session, isStreaming: true }, liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'Streaming text. '.repeat(index * 10) }] } }
      started = performance.now()
      render()
      streamed.push(performance.now() - started)
      await Bun.sleep(85)
      root.renderer.flush()
    }
    state = { ...state, session: { ...state.session, isStreaming: false }, liveAssistant: undefined }
    render()
    await Bun.sleep(550)
    root.renderer.flush()
    const wheel: number[] = []
    for (let index = 0; index < 100; index++) {
      started = performance.now()
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, index < 50 ? 120 : -120)
      root.renderer.flush()
      wheel.push(performance.now() - started)
      await Bun.sleep(1)
    }
    results.push({ turns, rich, mountMs: +mountMs.toFixed(2), mountedRows: root.renderer.findByTestId('transcript-list')?.children.length, tailPainted, unrelatedStateUpdate: summary(unrelated), streamingRender: summary(streamed), syntheticWheelAndFlush: summary(wheel) })
  } finally { root.unmount() }
}
console.log(JSON.stringify({ experiment: 'production source', limits: 'Offscreen native render/flush timings, not input-to-present or display FPS. Streaming samples time the immediate commit, not subsequent throttled markdown effects. Cases run sequentially in one process; first-case initialization differs. Window size is not a display-FPS measurement.', results }, null, 2))
process.exit(0)
