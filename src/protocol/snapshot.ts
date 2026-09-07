import type { ComposerImage } from '../pi/types.ts'
import { ledgerNotices } from '../workbench/notices.ts'
import type { WorkbenchState } from '../workbench/state.ts'

// Images above this size travel as a placeholder so a snapshot stays cheap to send over a socket.
export const SNAPSHOT_IMAGE_LIMIT_BYTES = 256 * 1024

export interface OmittedImageData {
  omitted: true
  bytes: number
}

export type SnapshotComposerImage = Omit<ComposerImage, 'data'> & { data: string | OmittedImageData }

export type WorkbenchSnapshot = Omit<WorkbenchState, 'editorImages'> & { editorImages: SnapshotComposerImage[] }

export type SnapshotKey = keyof WorkbenchSnapshot

export interface SnapshotPatch {
  version: 1
  changed: Partial<WorkbenchSnapshot>
  // JSON drops undefined values, so clearing optional state needs explicit tombstones.
  removed?: SnapshotKey[]
  // Older history pages travel as the new head only; the client keeps its existing tail.
  messagesPrepend?: WorkbenchSnapshot['messages']
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

export function diffSnapshots(previous: WorkbenchSnapshot | undefined, next: WorkbenchSnapshot): SnapshotPatch {
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
  return { version: 1, changed, ...(removed.length ? { removed } : {}), ...(prepended ? { messagesPrepend: prepended } : {}) }
}

export function applySnapshotPatch(current: WorkbenchSnapshot, patch: SnapshotPatch): WorkbenchSnapshot {
  const next = { ...current, ...patch.changed }
  for (const key of patch.removed ?? []) delete (next as Partial<WorkbenchSnapshot>)[key]
  if (patch.messagesPrepend) next.messages = [...patch.messagesPrepend, ...(current.messages ?? [])]
  return next
}

export function isPatchEmpty(patch: SnapshotPatch): boolean {
  return Object.keys(patch.changed).length === 0 && !patch.removed?.length && !patch.messagesPrepend?.length
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
