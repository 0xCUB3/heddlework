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
}

export function serializeSnapshot(state: WorkbenchState): WorkbenchSnapshot {
  return {
    ...state,
    notices: ledgerNotices(state.notices),
    editorImages: state.editorImages.map(serializeImage),
  }
}

export function diffSnapshots(previous: WorkbenchSnapshot | undefined, next: WorkbenchSnapshot): SnapshotPatch {
  const changed: Partial<WorkbenchSnapshot> = {}
  const removed: SnapshotKey[] = []
  for (const key of Object.keys(next) as SnapshotKey[]) {
    if (previous && Object.is(previous[key], next[key])) continue
    ;(changed as Record<string, unknown>)[key] = next[key]
    if (previous && next[key] === undefined && previous[key] !== undefined) removed.push(key)
  }
  if (previous) {
    for (const key of Object.keys(previous) as SnapshotKey[]) {
      if (!(key in next)) removed.push(key)
    }
  }
  return { version: 1, changed, ...(removed.length ? { removed } : {}) }
}

export function applySnapshotPatch(current: WorkbenchSnapshot, patch: SnapshotPatch): WorkbenchSnapshot {
  const next = { ...current, ...patch.changed }
  for (const key of patch.removed ?? []) delete (next as Partial<WorkbenchSnapshot>)[key]
  return next
}

export function isPatchEmpty(patch: SnapshotPatch): boolean {
  return Object.keys(patch.changed).length === 0 && !patch.removed?.length
}

function serializeImage(image: ComposerImage): SnapshotComposerImage {
  const bytes = image.size || image.data.length
  if (bytes <= SNAPSHOT_IMAGE_LIMIT_BYTES) return image
  return { ...image, data: { omitted: true, bytes } }
}
