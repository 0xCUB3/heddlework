import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileQueueStore } from '../src/workbench/queue-store.ts'
import { createQueueState } from '../src/workbench/queue.ts'

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
      flow: { runId: 'HW-ONE', taskId: 'HW-ONE-1', title: 'One', mode: 'sequential', source: 'manual', taskIndex: 0, taskCount: 1, phase: 'new-session' },
    }]
    queue.dispatchingId = 'queue-1'
    store.save('/tmp/project', queue)

    const restored = new FileQueueStore(path).load('/tmp/project')
    expect(restored.items).toEqual(queue.items)
    expect(restored).toMatchObject({ paused: true, pauseReason: 'recovery', dispatchingId: undefined })
  })
})
