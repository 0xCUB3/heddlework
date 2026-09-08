import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir, cpus } from 'node:os'
import { join } from 'node:path'
import { PiSessionHistoryPager } from '../src/pi/session-history.ts'
import { PiSessionCatalog, getPiSessionDirectory } from '../src/pi/session-catalog.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { buildTimeline } from '../src/workbench/timeline.ts'
import { groupWorkItems, projectTranscriptRows } from '../src/ui/transcript-projection.ts'
import { applySnapshotPatch, diffSnapshots, serializeSnapshot } from '../src/protocol/snapshot.ts'
import { findTranscriptDetail, projectWorkbenchSnapshot } from '../src/protocol/transcript.ts'
import { encodeFrames, FrameAssembler, MAX_ASSEMBLED_BYTES } from '../src/protocol/frames.ts'
import type { PiMessage } from '../src/pi/types.ts'

// Synthetic fixtures only. No Pi process, user history, credentials, or network access.
const directory = await mkdtemp(join(tmpdir(), 'heddlework-responsiveness-'))
const results: Record<string, unknown>[] = []
const mib = (bytes: number) => Number((bytes / 1024 / 1024).toFixed(2))
async function measure(label: string, run: () => unknown | Promise<unknown>, repeats = 3) {
  const elapsed: number[] = []
  const lag: number[] = []
  let value: unknown
  for (let index = 0; index < repeats; index++) {
    await Bun.sleep(10)
    let last = performance.now()
    let maximum = 0
    const timer = setInterval(() => { const now = performance.now(); maximum = Math.max(maximum, now - last - 1); last = now }, 1)
    const started = performance.now()
    try { value = await run() } finally {
      elapsed.push(performance.now() - started)
      await Bun.sleep(2)
      clearInterval(timer)
      lag.push(maximum)
    }
  }
  const sorted = [...elapsed].sort((a, b) => a - b)
  results.push({ label, ms: elapsed.map(n => Number(n.toFixed(2))), medianMs: Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(2)), maxTimerLagMs: Number(Math.max(...lag).toFixed(2)), value })
}
function entry(id: number, message: PiMessage) {
  return JSON.stringify({ type: 'message', id: `m${id}`, parentId: id ? `m${id - 1}` : null, message }) + '\n'
}
try {
  for (const bytes of [1024, 128 * 1024, 512 * 1024]) {
    const path = join(directory, `page-${bytes}.jsonl`)
    const output = 'x'.repeat(bytes)
    await writeFile(path, Array.from({ length: 100 }, (_, id) => entry(id, { role: 'toolResult', toolCallId: `tool-${id}`, toolName: 'read', content: output })).join(''))
    await measure(`history 80 tool results x ${bytes} bytes`, async () => {
      const page = await new PiSessionHistoryPager(path).loadEarlier(80)
      return { messages: page.messages.length, payloadMiB: mib(JSON.stringify(page.messages).length), hasOlder: page.hasOlder }
    })
  }
  for (const sizeMiB of [1, 4, 16]) {
    const path = join(directory, `hidden-${sizeMiB}.jsonl`)
    await writeFile(path, entry(0, { role: 'user', content: 'Visible prompt' }) + JSON.stringify({ type: 'custom', id: 'hidden', parentId: 'm0', data: { payload: 'x'.repeat(sizeMiB * 1024 * 1024) } }) + '\n' + JSON.stringify({ type: 'message', id: 'last', parentId: 'hidden', message: { role: 'assistant', content: 'Visible answer' } }) + '\n')
    await measure(`history across one ${sizeMiB} MiB hidden record`, async () => (await new PiSessionHistoryPager(path).loadEarlier(80)).messages.length)
  }
  const state = createInitialState(directory)
  let previous = projectWorkbenchSnapshot(serializeSnapshot(state))
  let applied = previous
  let totalBytes = 0
  const fullLive = { id: 'live', blocks: [{ index: 0, kind: 'text' as const, text: 'x'.repeat(200 * 1024) }] }
  for (let index = 1; index <= 200; index++) {
    const full = serializeSnapshot({ ...state, liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text: 'x'.repeat(index * 1024) }] } })
    const next = projectWorkbenchSnapshot(full)
    const patch = diffSnapshots(previous, next)
    totalBytes += JSON.stringify({ kind: 'patch', patch }).length
    applied = applySnapshotPatch(applied, patch)
    previous = next
  }
  const recovered = findTranscriptDetail({ liveAssistant: fullLive }, 'live')
  results.push({
    label: '200 live snapshots growing by 1 KiB',
    generatedKiB: 200,
    serializedMiB: mib(totalBytes),
    amplification: Number((totalBytes / (200 * 1024)).toFixed(1)),
    retainedTail: applied.liveAssistant?.blocks[0]?.text.length,
    recovered: recovered?.kind === 'liveAssistant',
  })
  for (const count of [80, 240]) {
    const messages: PiMessage[] = Array.from({ length: count }, (_, index) => ({ role: 'toolResult', toolName: 'read', toolCallId: `t${index}`, content: 'x'.repeat(160 * 1024) }))
    const snapshot = serializeSnapshot({ ...state, messages })
    const json = JSON.stringify({ kind: 'patch', patch: diffSnapshots(undefined, snapshot) })
    await measure(`wire encode/assemble/parse ${count} x 160 KiB results`, () => {
      const assembler = new FrameAssembler()
      const frames = encodeFrames(json)
      let assembled: unknown
      try { for (const frame of frames) assembled = assembler.push(frame) } catch (error) {
        return { payloadMiB: mib(json.length), frames: frames.length, capMiB: mib(MAX_ASSEMBLED_BYTES), rejected: error instanceof Error ? error.message : String(error) }
      }
      if (assembled === undefined) throw new Error('Fixture did not assemble')
      const decoded = (typeof assembled === 'string' ? JSON.parse(assembled) : assembled) as { patch: { changed: { messages: unknown[] } } }
      return { payloadMiB: mib(json.length), frames: frames.length, messages: decoded.patch.changed.messages.length }
    })
    await measure(`project ${count} x 160 KiB collapsed tool results`, () => projectTranscriptRows(groupWorkItems(buildTimeline(messages, undefined, [], [])), new Set(), new Map()).length)
  }
  const agentDir = join(directory, 'agent')
  const sessionsDir = getPiSessionDirectory(directory, agentDir)
  await mkdir(sessionsDir, { recursive: true })
  let created = 0
  for (const count of [100, 1000, 5000]) {
    while (created < count) {
      const end = Math.min(count, created + 64)
      await Promise.all(Array.from({ length: end - created }, (_, i) => {
        const id = created + i
        return writeFile(join(sessionsDir, `${id}.jsonl`), JSON.stringify({ type: 'session', id: String(id), cwd: directory, timestamp: new Date(id * 1000).toISOString() }) + '\n' + entry(0, { role: 'user', content: `Prompt ${id}` }))
      }))
      created = end
    }
    const catalog = new PiSessionCatalog({ agentDir, cachePath: false, liveBridgeDirectory: false })
    await measure(`catalog ${count} files cold, return 31`, async () => (await catalog.list(directory, 31)).length, 1)
    await measure(`catalog ${count} files warm, return 31`, async () => (await catalog.list(directory, 31)).length)
  }
  console.log(JSON.stringify({ environment: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model }, limits: 'Synthetic CPU/I/O and timer-delay probes; not display FPS. Three runs share the OS file cache. History measurements include payload-size serialization.', results }, null, 2))
} finally {
  await rm(directory, { recursive: true, force: true })
}
