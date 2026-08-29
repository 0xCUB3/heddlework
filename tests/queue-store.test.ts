import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileQueueStore } from '../src/workbench/queue-store.ts'
import {
  createQueueState,
  moveQueuedInputToLaneTail,
  parseQueuedControl,
  queuedInputControl,
  queueItemsInDeliveryOrder,
  type QueuedInput,
} from '../src/workbench/queue.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('FileQueueStore', () => {
  it('restores stable Flow rows and pauses an interrupted dispatch for explicit recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-queue-store-'))
    roots.push(root)
    const path = join(root, 'queue.json')
    const store = new FileQueueStore(path)
    const queue = createQueueState()
    queue.items = [{
      id: 'queue-1',
      text: '/new',
      images: [],
      createdAt: 10,
      lane: 'followUp',
      paused: true,
      flow: { runId: 'HW-ONE', taskId: 'HW-ONE-1', title: 'One', mode: 'sequential', source: 'manual', taskIndex: 0, taskCount: 1, phase: 'new-session' },
    }]
    queue.dispatchingId = 'queue-1'
    store.save('/tmp/project', queue)

    const restored = new FileQueueStore(path).load('/tmp/project')
    expect(restored.items).toEqual(queue.items)
    expect(restored).toMatchObject({ paused: true, pauseReason: 'recovery', dispatchingId: undefined })
  })

  it('parses only exact queue controls and keeps attachment-bearing slash rows as prompts', () => {
    expect(parseQueuedControl('/fabric prewalk')).toEqual({ kind: 'fabric-prewalk' })
    expect(parseQueuedControl('/fabric await reviewer')).toEqual({ kind: 'fabric-await', peer: 'reviewer' })
    expect(parseQueuedControl('/fabric await')).toEqual({ kind: 'fabric-await' })
    expect(parseQueuedControl('/fabric prewalk now')).toBeUndefined()
    expect(parseQueuedControl('/fabric status')).toBeUndefined()
    expect(parseQueuedControl('/compact retain decisions')).toEqual({ kind: 'compact', instructions: 'retain decisions' })
    expect(parseQueuedControl('/model provider/model')).toEqual({ kind: 'model', target: 'provider/model' })
    expect(parseQueuedControl('/name Release train')).toEqual({ kind: 'builtin', name: 'name', argument: 'Release train' })
    expect(parseQueuedControl('/settings')).toEqual({ kind: 'builtin', name: 'settings' })
    expect(queuedInputControl({ text: '/fabric prewalk', images: [{ id: 'image', type: 'image', data: 'aQ==', mimeType: 'image/png', fileName: 'i.png', size: 1 }] })).toBeUndefined()
  })

  it('orders independent lanes and moves rows to the destination lane tail', () => {
    const rows: QueuedInput[] = [
      { id: 'follow-1', text: 'follow one', images: [], createdAt: 1, lane: 'followUp' },
      { id: 'steer-1', text: 'steer one', images: [], createdAt: 2, lane: 'steer' },
      { id: 'follow-2', text: 'follow two', images: [], createdAt: 3, lane: 'followUp', paused: true },
    ]
    expect(queueItemsInDeliveryOrder(rows).map((row) => row.id)).toEqual(['steer-1', 'follow-1', 'follow-2'])
    const moved = moveQueuedInputToLaneTail(rows, 'follow-1', 'steer')
    expect(moved.map((row) => [row.id, row.lane])).toEqual([['steer-1', 'steer'], ['follow-1', 'steer'], ['follow-2', 'followUp']])
    expect(rows[0]).toMatchObject({ id: 'follow-1', lane: 'followUp' })
  })
})
