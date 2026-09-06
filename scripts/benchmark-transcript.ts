import { groupWorkItems, projectTranscriptRows, transcriptProjectionRowsEqual } from '../src/ui/transcript-projection.ts'
import { reuseRowsById, TRANSCRIPT_VIRTUAL_WINDOW_SIZE, virtualWindowForTail, visibleWindow, webTranscriptWindow } from '../src/ui/virtual-window.ts'
import { buildTimeline } from '../src/workbench/timeline.ts'
import type { PiMessage } from '../src/pi/types.ts'

function messages(turns: number): PiMessage[] {
  return Array.from({ length: turns }, (_, index): PiMessage[] => [
    { role: 'user', content: `Prompt ${index}`, timestamp: index * 2 },
    { role: 'assistant', content: `Answer ${index}\n\n\`\`\`ts\nconst value = ${index}\n\`\`\``, timestamp: index * 2 + 1 },
  ]).flat()
}

function project(turns: number) {
  const timeline = buildTimeline(messages(turns), undefined, [], [])
  return projectTranscriptRows(groupWorkItems(timeline), new Set(), new Map())
}

function time(label: string, run: () => void): number {
  const started = performance.now()
  run()
  const elapsed = performance.now() - started
  console.log(`${label}: ${elapsed.toFixed(2)}ms`)
  return elapsed
}

const rows200 = project(200)
const rows1000 = project(1_000)
time('project 200 turns', () => { project(200) })
time('project 1_000 turns', () => { project(1_000) })

const grown = projectTranscriptRows(groupWorkItems(buildTimeline(messages(200), { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'Streaming answer' }] }, [], [])), new Set(), new Map())
const reused = reuseRowsById(rows200, grown, transcriptProjectionRowsEqual)
const reusedCount = reused.filter((row, index) => row === rows200[index]).length
console.log(`reuse unchanged rows after live token: ${reusedCount}/${rows200.length}`)

const native = visibleWindow(rows1000.length, virtualWindowForTail(rows1000.length, TRANSCRIPT_VIRTUAL_WINDOW_SIZE), TRANSCRIPT_VIRTUAL_WINDOW_SIZE)
const web = webTranscriptWindow(rows1000.length, 0, 640, true)
console.log(`native 1000-turn window: ${native.end - native.start} of ${rows1000.length}`)
console.log(`web 1000-turn window: ${web.end - web.start} of ${rows1000.length}`)
console.log('These are CPU / work-count numbers, not frame times.')
