import type { ComposerImage } from '../pi/types.ts'
import type { FlowQueueMetadata } from '../flows/types.ts'

export type QueueLane = 'steer' | 'followUp'
export type QueuePauseReason = 'abort' | 'error' | 'manual' | 'recovery'

export interface QueueInputDraft {
  text: string
  images?: readonly ComposerImage[] | undefined
  lane?: QueueLane | undefined
  flow?: FlowQueueMetadata | undefined
}

export interface QueuedInput {
  id: string
  text: string
  images: ComposerImage[]
  createdAt: number
  lane?: QueueLane | undefined
  flow?: FlowQueueMetadata | undefined
}

export interface WorkbenchQueueState {
  items: QueuedInput[]
  steering: string[]
  followUp: string[]
  paused: boolean
  pauseReason: QueuePauseReason | undefined
  dispatchingId: string | undefined
}

export function createQueueState(): WorkbenchQueueState {
  return {
    items: [],
    steering: [],
    followUp: [],
    paused: false,
    pauseReason: undefined,
    dispatchingId: undefined,
  }
}

export function moveQueuedInput(items: readonly QueuedInput[], id: string, targetIndex: number): QueuedInput[] {
  const fromIndex = items.findIndex((item) => item.id === id)
  if (fromIndex < 0 || items.length < 2) return [...items]
  const boundedTarget = Math.max(0, Math.min(items.length - 1, targetIndex))
  if (fromIndex === boundedTarget) return [...items]
  const next = [...items]
  const [item] = next.splice(fromIndex, 1)
  if (!item) return [...items]
  next.splice(boundedTarget, 0, item)
  return next
}

export function queueSize(queue: WorkbenchQueueState): number {
  return queue.items.length + queue.steering.length + queue.followUp.length
}

export function serializeQueueState(queue: WorkbenchQueueState): Record<string, unknown> {
  return {
    items: queue.items,
    paused: queue.paused,
    ...(queue.pauseReason ? { pauseReason: queue.pauseReason } : {}),
    ...(queue.dispatchingId ? { dispatchingId: queue.dispatchingId } : {}),
  }
}

export function restoreQueueState(value: unknown): WorkbenchQueueState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return createQueueState()
  const record = value as Record<string, unknown>
  const items = Array.isArray(record.items) ? record.items.flatMap(readQueuedInput) : []
  const wasDispatching = typeof record.dispatchingId === 'string' && items.some((item) => item.id === record.dispatchingId)
  const pauseReason = readPauseReason(record.pauseReason)
  return {
    items,
    steering: [],
    followUp: [],
    paused: wasDispatching || Boolean(record.paused),
    pauseReason: wasDispatching ? 'recovery' : pauseReason,
    dispatchingId: undefined,
  }
}

function readQueuedInput(value: unknown): QueuedInput[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return []
  const item = value as Record<string, unknown>
  if (typeof item.id !== 'string' || typeof item.text !== 'string' || typeof item.createdAt !== 'number' || !Array.isArray(item.images)) return []
  const images = item.images.filter(isComposerImage)
  if (images.length !== item.images.length) return []
  const lane = item.lane === 'steer' || item.lane === 'followUp' ? item.lane : undefined
  const flow = readFlowMetadata(item.flow)
  return [{
    id: item.id,
    text: item.text,
    images,
    createdAt: item.createdAt,
    ...(lane ? { lane } : {}),
    ...(flow ? { flow } : {}),
  }]
}

function isComposerImage(value: unknown): value is ComposerImage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const image = value as Record<string, unknown>
  return image.type === 'image' && typeof image.id === 'string' && typeof image.data === 'string' && typeof image.mimeType === 'string' && typeof image.fileName === 'string' && typeof image.size === 'number'
}

function readFlowMetadata(value: unknown): FlowQueueMetadata | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const flow = value as Record<string, unknown>
  if (typeof flow.runId !== 'string' || typeof flow.taskId !== 'string' || typeof flow.title !== 'string') return undefined
  if (flow.mode !== 'sequential' && flow.mode !== 'parallel') return undefined
  if (flow.source !== 'manual' && flow.source !== 'scheduled') return undefined
  if (typeof flow.taskIndex !== 'number' || typeof flow.taskCount !== 'number') return undefined
  if (flow.phase !== 'new-session' && flow.phase !== 'set-model' && flow.phase !== 'set-name' && flow.phase !== 'prompt') return undefined
  return {
    runId: flow.runId,
    taskId: flow.taskId,
    title: flow.title,
    mode: flow.mode,
    source: flow.source,
    ...(typeof flow.scheduleId === 'string' ? { scheduleId: flow.scheduleId } : {}),
    taskIndex: flow.taskIndex,
    taskCount: flow.taskCount,
    phase: flow.phase,
  }
}

function readPauseReason(value: unknown): QueuePauseReason | undefined {
  return value === 'abort' || value === 'error' || value === 'manual' || value === 'recovery' ? value : undefined
}
