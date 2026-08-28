import type { ComposerImage } from '../pi/types.ts'

export interface QueuedInput {
  id: string
  text: string
  images: ComposerImage[]
  createdAt: number
}

export interface WorkbenchQueueState {
  items: QueuedInput[]
  steering: string[]
  followUp: string[]
  paused: boolean
  pauseReason: 'abort' | 'error' | 'manual' | undefined
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
