import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { FileThreadMetadataStore, type ThreadMetadataStoreService } from '../src/workbench/thread-metadata-store.ts'
import type { ThreadLifecycle } from '../src/workbench/state.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('thread projection metadata', () => {
  it('atomically restores normalized lifecycle, read, priority, and label preferences', async () => {
    const root = await mkdtemp(join(tmpdir(), 'heddlework-thread-store-'))
    roots.push(root)
    const path = join(root, 'threads.json')
    const store = new FileThreadMetadataStore(path)
    store.save({
      '/tmp/session.jsonl': {
        settledAt: 10,
        readAt: 20,
        priority: 2,
        labels: [' release ', 'Release', 'needs   review'],
      },
    })

    expect(new FileThreadMetadataStore(path).load()).toEqual({
      '/tmp/session.jsonl': {
        settledAt: 10,
        readAt: 20,
        priority: 2,
        labels: ['release', 'needs review'],
      },
    })
  })

  it('saves controller label, priority, read, and unsettle updates without erasing adjacent metadata', async () => {
    let stored: Record<string, ThreadLifecycle> = { '/tmp/session.jsonl': { settledAt: 5, labels: ['existing'] } }
    const metadataStore: ThreadMetadataStoreService = {
      load: () => structuredClone(stored),
      save: (next) => { stored = structuredClone(next) },
    }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/project', {
      ...testControllerDependencies(),
      threadMetadataStore: metadataStore,
    })
    try {
      controller.setThreadPriority('/tmp/session.jsonl', 1)
      controller.setThreadLabels('/tmp/session.jsonl', ['release', 'blocked'])
      controller.markThreadRead('/tmp/session.jsonl', 30)
      controller.wakeThread('/tmp/session.jsonl')
      expect(stored['/tmp/session.jsonl']).toMatchObject({ priority: 1, labels: ['release', 'blocked'], readAt: 30 })
      expect(stored['/tmp/session.jsonl']?.settledAt).toBeUndefined()
      expect(stored['/tmp/session.jsonl']?.unsettledAt).toBeNumber()
    } finally {
      await controller.dispose()
    }
  })

  it('marks many projected threads read in one durable update', async () => {
    let stored: Record<string, ThreadLifecycle> = { '/tmp/already-read.jsonl': { readAt: 50 } }
    let saves = 0
    const metadataStore: ThreadMetadataStoreService = {
      load: () => structuredClone(stored),
      save: (next) => { saves += 1; stored = structuredClone(next) },
    }
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/project', {
      ...testControllerDependencies(),
      threadMetadataStore: metadataStore,
    })
    try {
      controller.markThreadsRead([
        { path: '/tmp/first.jsonl', updatedAt: 30 },
        { path: '/tmp/second.jsonl', updatedAt: 40 },
        { path: '/tmp/already-read.jsonl', updatedAt: 20 },
      ])
      expect(saves).toBe(1)
      expect(stored['/tmp/first.jsonl']?.readAt).toBe(30)
      expect(stored['/tmp/second.jsonl']?.readAt).toBe(40)
      expect(stored['/tmp/already-read.jsonl']?.readAt).toBe(50)

      controller.markThreadsRead([{ path: '/tmp/first.jsonl', updatedAt: 25 }])
      expect(saves).toBe(1)
    } finally {
      await controller.dispose()
    }
  })
})
