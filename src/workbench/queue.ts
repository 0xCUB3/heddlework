import type { ComposerImage } from '../pi/types.ts'

export type QueuedControl =
  | { kind: 'compact'; instructions?: string }
  | { kind: 'new' }
  | { kind: 'model'; target?: string }
  | { kind: 'thinking'; level?: string }
  | { kind: 'reload' }

export function parseQueuedControl(text: string): QueuedControl | undefined {
  const trimmed = text.trim()
  if (trimmed === '/compact') return { kind: 'compact' }
  if (trimmed.startsWith('/compact ')) {
    const instructions = trimmed.slice('/compact '.length).trim()
    return instructions ? { kind: 'compact', instructions } : { kind: 'compact' }
  }
  if (trimmed === '/new') return { kind: 'new' }
  if (trimmed === '/model') return { kind: 'model' }
  if (trimmed.startsWith('/model ')) {
    const target = trimmed.slice('/model '.length).trim()
    return target ? { kind: 'model', target } : { kind: 'model' }
  }
  if (trimmed === '/thinking') return { kind: 'thinking' }
  if (trimmed.startsWith('/thinking ')) {
    const level = trimmed.slice('/thinking '.length).trim()
    return level ? { kind: 'thinking', level } : { kind: 'thinking' }
  }
  if (trimmed === '/reload') return { kind: 'reload' }
  return undefined
}

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
  pauseReason: 'abort' | 'error' | undefined
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
