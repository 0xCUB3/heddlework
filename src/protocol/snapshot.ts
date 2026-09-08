import type { ComposerImage } from '../pi/types.ts'
import type { LiveAssistant, LiveBlock, ToolRun } from '../workbench/state.ts'
import { ledgerNotices } from '../workbench/notices.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { dropUtf8Prefix } from './frames.ts'

// Images above this size travel as a placeholder so a snapshot stays cheap to send over a socket.
export const SNAPSHOT_IMAGE_LIMIT_BYTES = 256 * 1024
export const LIVE_QUEUE_BUDGET_BYTES = 256 * 1024

export interface OmittedImageData {
  omitted: true
  bytes: number
}

export type SnapshotComposerImage = Omit<ComposerImage, 'data'> & { data: string | OmittedImageData }

export type WorkbenchSnapshot = Omit<WorkbenchState, 'editorImages'> & { editorImages: SnapshotComposerImage[] }

export type SnapshotKey = keyof WorkbenchSnapshot

export type LiveContentOp =
  | { op: 'append'; target: 'assistant'; id: string; blockIndex: number; text: string }
  | { op: 'trim'; target: 'assistant'; id: string; blockIndex: number; bytes: number }
  | { op: 'append'; target: 'tool'; id: string; text: string }
  | { op: 'trim'; target: 'tool'; id: string; bytes: number }
  | { op: 'replace'; target: 'assistant'; assistant: LiveAssistant }
  | { op: 'replace'; target: 'tool'; tool: ToolRun }
  | { op: 'replace'; target: 'tools'; tools: ToolRun[] }

export interface SnapshotPatch {
  version: 1
  changed: Partial<WorkbenchSnapshot>
  // JSON drops undefined values, so clearing optional state needs explicit tombstones.
  removed?: SnapshotKey[]
  // Older history pages travel as the new head only; the client keeps its existing tail.
  messagesPrepend?: WorkbenchSnapshot['messages']
  liveOps?: LiveContentOp[]
  seq?: number
  contentRevision?: number
}

export interface DiffSnapshotOptions {
  resyncLive?: boolean
}

const serializedNotices = new WeakMap<WorkbenchState['notices'], WorkbenchSnapshot['notices']>()
const serializedEditorImages = new WeakMap<WorkbenchState['editorImages'], SnapshotComposerImage[]>()

export function serializeSnapshot(state: WorkbenchState): WorkbenchSnapshot {
  return {
    ...state,
    notices: memoizedLedgerNotices(state.notices),
    editorImages: memoizedEditorImages(state.editorImages),
  }
}

export function diffSnapshots(previous: WorkbenchSnapshot | undefined, next: WorkbenchSnapshot, options: DiffSnapshotOptions = {}): SnapshotPatch {
  const changed: Partial<WorkbenchSnapshot> = {}
  const removed: SnapshotKey[] = []
  const prepended = previous ? prependedMessages(previous.messages, next.messages) : undefined
  for (const key of Object.keys(next) as SnapshotKey[]) {
    if (previous && Object.is(previous[key], next[key])) continue
    if (key === 'messages' && prepended) continue
    ;(changed as Record<string, unknown>)[key] = next[key]
    if (previous && next[key] === undefined && previous[key] !== undefined) removed.push(key)
  }
  if (previous) {
    for (const key of Object.keys(previous) as SnapshotKey[]) {
      if (!(key in next)) removed.push(key)
    }
  }
  let liveOps: LiveContentOp[] | undefined
  if (previous && !options.resyncLive) {
    const assistant = liveAssistantOps(previous.liveAssistant, next.liveAssistant)
    const tools = liveToolOps(previous.liveTools, next.liveTools)
    const assistantOk = assistant !== 'resync'
    const toolsOk = tools !== 'resync'
    const ops: LiveContentOp[] = []
    if (assistantOk) {
      delete changed.liveAssistant
      if (assistant !== 'unchanged') ops.push(...assistant)
    }
    if (toolsOk) {
      delete changed.liveTools
      if (tools !== 'unchanged') ops.push(...tools)
    }
    if (ops.length) liveOps = ops
  }
  return {
    version: 1,
    changed,
    ...(removed.length ? { removed } : {}),
    ...(prepended ? { messagesPrepend: prepended } : {}),
    ...(liveOps?.length ? { liveOps } : {}),
  }
}

export function applySnapshotPatch(current: WorkbenchSnapshot, patch: SnapshotPatch): WorkbenchSnapshot {
  const next = { ...current, ...patch.changed }
  for (const key of patch.removed ?? []) delete (next as Partial<WorkbenchSnapshot>)[key]
  if (patch.messagesPrepend) next.messages = [...patch.messagesPrepend, ...(current.messages ?? [])]
  const ops = liveOpsForUnsyncedTargets(patch)
  if (ops.length) return applyLiveOps(next, ops)
  return next
}

export function applyLiveOps(snapshot: WorkbenchSnapshot, ops: readonly LiveContentOp[]): WorkbenchSnapshot {
  let next = snapshot
  for (const op of ops) next = applyLiveOp(next, op)
  return next
}

export function isPatchEmpty(patch: SnapshotPatch): boolean {
  return Object.keys(patch.changed).length === 0 && !patch.removed?.length && !patch.messagesPrepend?.length && !patch.liveOps?.length
}

export function isLiveOnlyPatch(patch: SnapshotPatch): boolean {
  const keys = Object.keys(patch.changed)
  if (patch.messagesPrepend?.length) return false
  if (patch.removed?.some((key) => key !== 'liveAssistant' && key !== 'liveTools')) return false
  for (const key of keys) {
    if (key !== 'liveAssistant' && key !== 'liveTools' && key !== 'activity') return false
  }
  return Boolean(patch.liveOps?.length) || keys.includes('liveAssistant') || keys.includes('liveTools') || (patch.removed ?? []).includes('liveAssistant') || (patch.removed ?? []).includes('liveTools')
}

export function snapshotNeedsLiveResync(previousSeq: number, patch: SnapshotPatch): boolean {
  if (patch.seq == null) return false
  if (previousSeq === 0) return false
  if (patch.seq === previousSeq + 1) return false
  return liveOpsForUnsyncedTargets(patch).length > 0
}

export function liveTargetResync(patch: SnapshotPatch): { assistant: boolean; tools: boolean } {
  const removed = patch.removed ?? []
  return {
    assistant: Object.prototype.hasOwnProperty.call(patch.changed, 'liveAssistant') || removed.includes('liveAssistant'),
    tools: Object.prototype.hasOwnProperty.call(patch.changed, 'liveTools') || removed.includes('liveTools'),
  }
}

function liveOpsForUnsyncedTargets(patch: SnapshotPatch): LiveContentOp[] {
  if (!patch.liveOps?.length) return []
  const flags = liveTargetResync(patch)
  return patch.liveOps.filter((op) => {
    if (op.target === 'assistant') return !flags.assistant
    if (op.target === 'tool' || op.target === 'tools') return !flags.tools
    return true
  })
}

// A history page keeps every previously sent message as the same object at the tail of the new array.
function prependedMessages(previous: WorkbenchSnapshot['messages'], next: WorkbenchSnapshot['messages']): WorkbenchSnapshot['messages'] | undefined {
  if (previous === next || previous.length === 0 || next.length <= previous.length) return undefined
  const offset = next.length - previous.length
  for (let index = 0; index < previous.length; index += 1) {
    if (previous[index] !== next[offset + index]) return undefined
  }
  return next.slice(0, offset)
}

type LiveDiff<T> = T | 'resync' | 'unchanged'

function liveAssistantOps(previous: LiveAssistant | undefined, next: LiveAssistant | undefined): LiveDiff<LiveContentOp[]> {
  if (previous === next) return 'unchanged'
  if (!next || !previous) return 'resync'
  if (previous.id !== next.id) return 'resync'
  if (previous.blocks.length !== next.blocks.length) return 'resync'
  const ops: LiveContentOp[] = []
  for (let index = 0; index < next.blocks.length; index += 1) {
    const before = previous.blocks[index]!
    const after = next.blocks[index]!
    if (before.index !== after.index || before.kind !== after.kind) return 'resync'
    const window = slidingTextOps(before.text, before.textOffset ?? 0, after.text, after.textOffset ?? 0)
    if (window === 'resync') return 'resync'
    if (window.dropBytes > 0) ops.push({ op: 'trim', target: 'assistant', id: next.id, blockIndex: after.index, bytes: window.dropBytes })
    if (window.append) ops.push({ op: 'append', target: 'assistant', id: next.id, blockIndex: after.index, text: window.append })
  }
  return ops.length ? ops : 'unchanged'
}

function liveToolOps(previous: ToolRun[] | undefined, next: ToolRun[] | undefined): LiveDiff<LiveContentOp[]> {
  if (previous === next) return 'unchanged'
  const before = previous ?? []
  const after = next ?? []
  if (before.length !== after.length) return 'resync'
  const ops: LiveContentOp[] = []
  for (let index = 0; index < after.length; index += 1) {
    const left = before[index]!
    const right = after[index]!
    if (left.id !== right.id || left.name !== right.name || left.status !== right.status || left.isError !== right.isError) return 'resync'
    if (left.args !== right.args || left.argsText !== right.argsText || left.details !== right.details) return 'resync'
    const window = slidingTextOps(left.output ?? '', left.outputOffset ?? 0, right.output ?? '', right.outputOffset ?? 0)
    if (window === 'resync') return 'resync'
    if (window.dropBytes > 0) ops.push({ op: 'trim', target: 'tool', id: right.id, bytes: window.dropBytes })
    if (window.append) ops.push({ op: 'append', target: 'tool', id: right.id, text: window.append })
  }
  return ops.length ? ops : 'unchanged'
}

function slidingTextOps(previous: string, previousOffset: number, next: string, nextOffset: number): { dropBytes: number; append: string } | 'resync' {
  if (previous === next && previousOffset === nextOffset) return { dropBytes: 0, append: '' }
  if (nextOffset < previousOffset) return 'resync'
  const dropBytes = nextOffset - previousOffset
  const kept = dropBytes > 0 ? dropUtf8Prefix(previous, dropBytes) : previous
  if (!next.startsWith(kept)) return 'resync'
  return { dropBytes, append: next.slice(kept.length) }
}

function applyLiveOp(snapshot: WorkbenchSnapshot, op: LiveContentOp): WorkbenchSnapshot {
  if (op.op === 'append' && op.target === 'assistant') {
    const assistant = snapshot.liveAssistant
    if (!assistant || assistant.id !== op.id) return snapshot
    const blocks = assistant.blocks.map((block): LiveBlock => (
      block.index === op.blockIndex ? { ...block, text: block.text + op.text } : block
    ))
    return { ...snapshot, liveAssistant: { ...assistant, blocks } }
  }
  if (op.op === 'trim' && op.target === 'assistant') {
    const assistant = snapshot.liveAssistant
    if (!assistant || assistant.id !== op.id || op.bytes <= 0) return snapshot
    const blocks = assistant.blocks.map((block): LiveBlock => {
      if (block.index !== op.blockIndex) return block
      return {
        ...block,
        text: dropUtf8Prefix(block.text, op.bytes),
        textOffset: (block.textOffset ?? 0) + op.bytes,
      }
    })
    return { ...snapshot, liveAssistant: { ...assistant, blocks } }
  }
  if (op.op === 'append' && op.target === 'tool') {
    const liveTools = snapshot.liveTools.map((tool) => {
      if (tool.id !== op.id) return tool
      return { ...tool, output: (tool.output ?? '') + op.text }
    })
    return { ...snapshot, liveTools }
  }
  if (op.op === 'trim' && op.target === 'tool') {
    const liveTools = snapshot.liveTools.map((tool) => {
      if (tool.id !== op.id || op.bytes <= 0) return tool
      return {
        ...tool,
        output: dropUtf8Prefix(tool.output ?? '', op.bytes),
        outputOffset: (tool.outputOffset ?? 0) + op.bytes,
      }
    })
    return { ...snapshot, liveTools }
  }
  if (op.op === 'replace' && op.target === 'assistant') {
    return { ...snapshot, liveAssistant: op.assistant }
  }
  if (op.op === 'replace' && op.target === 'tool') {
    let found = false
    const liveTools = snapshot.liveTools.map((tool) => {
      if (tool.id !== op.tool.id) return tool
      found = true
      return op.tool
    })
    return { ...snapshot, liveTools: found ? liveTools : [...liveTools, op.tool] }
  }
  if (op.op === 'replace' && op.target === 'tools') {
    return { ...snapshot, liveTools: op.tools }
  }
  return snapshot
}

function serializeImage(image: ComposerImage): SnapshotComposerImage {
  const bytes = image.size || image.data.length
  if (bytes <= SNAPSHOT_IMAGE_LIMIT_BYTES) return image
  return { ...image, data: { omitted: true, bytes } }
}

function memoizedLedgerNotices(notices: WorkbenchState['notices']): WorkbenchSnapshot['notices'] {
  const cached = serializedNotices.get(notices)
  if (cached) return cached
  const next = ledgerNotices(notices)
  serializedNotices.set(notices, next)
  return next
}

function memoizedEditorImages(images: WorkbenchState['editorImages']): SnapshotComposerImage[] {
  const cached = serializedEditorImages.get(images)
  if (cached) return cached
  const next = images.map(serializeImage)
  serializedEditorImages.set(images, next)
  return next
}
