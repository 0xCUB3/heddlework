import { describe, expect, it } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileReceiptStore, type ReceiptStoreIO } from '../src/receipts/store.ts'
import { RECEIPTS_PER_SESSION, type MutationReceipt } from '../src/receipts/types.ts'

function receipt(id: string, sessionPath = '/tmp/s.jsonl'): MutationReceipt {
  return { id, sessionPath, turn: 1, startedAt: 1, completedAt: 2, files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '' }], tools: [] }
}

describe('receipt store', () => {
  it('appends, caps per session, clears, and reloads from disk', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heddlework-receipts-'))
    const path = join(dir, 'nested', 'receipts.json')
    const store = new FileReceiptStore(path)
    for (let index = 0; index < RECEIPTS_PER_SESSION + 5; index += 1) store.append(receipt(`R${index}`))
    store.append(receipt('other', '/tmp/other.jsonl'))
    expect(store.list('/tmp/s.jsonl')).toHaveLength(RECEIPTS_PER_SESSION)
    expect(store.list('/tmp/s.jsonl')[0]!.id).toBe('R5')
    await store.flushed()

    const reloaded = new FileReceiptStore(path)
    expect(reloaded.list('/tmp/s.jsonl')).toHaveLength(RECEIPTS_PER_SESSION)
    expect(reloaded.list('/tmp/other.jsonl').map((entry) => entry.id)).toEqual(['other'])

    reloaded.clear('/tmp/s.jsonl')
    await reloaded.flushed()
    expect(reloaded.list('/tmp/s.jsonl')).toEqual([])
    expect(new FileReceiptStore(path).list('/tmp/s.jsonl')).toEqual([])
    expect(new FileReceiptStore(path).list('/tmp/other.jsonl')).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('schedules a flush when flushed() is called while dirty after a write failure path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heddlework-receipts-'))
    const path = join(dir, 'receipts.json')
    const store = new FileReceiptStore(path)
    store.append(receipt('kept'))
    const pending = store.flushed()
    await pending
    expect(existsSync(path)).toBe(true)
    await store.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps working in memory when persistence is off', () => {
    const store = new FileReceiptStore(false)
    store.append(receipt('x'))
    expect(store.list('/tmp/s.jsonl').map((entry) => entry.id)).toEqual(['x'])
  })

  it('does not block the turn on disk and survives a crash after append', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'heddlework-receipts-'))
    const path = join(dir, 'receipts.json')
    const store = new FileReceiptStore(path)
    store.append(receipt('kept'))
    expect(existsSync(path)).toBe(false)
    expect(store.list('/tmp/s.jsonl').map((entry) => entry.id)).toEqual(['kept'])
    await store.flushed()
    expect(existsSync(path)).toBe(true)

    const crashed = new FileReceiptStore(path)
    expect(crashed.list('/tmp/s.jsonl').map((entry) => entry.id)).toEqual(['kept'])

    crashed.append(receipt('second'))
    crashed.append(receipt('third'))
    await crashed.flushed()
    expect(new FileReceiptStore(path).list('/tmp/s.jsonl').map((entry) => entry.id)).toEqual(['kept', 'second', 'third'])

    writeFileSync(`${path}.${process.pid}.tmp`, '{truncated')
    expect(new FileReceiptStore(path).list('/tmp/s.jsonl').map((entry) => entry.id)).toEqual(['kept', 'second', 'third'])
    expect(JSON.parse(readFileSync(path, 'utf8')).sessions['/tmp/s.jsonl'].map((entry: MutationReceipt) => entry.id)).toEqual(['kept', 'second', 'third'])
    rmSync(dir, { recursive: true, force: true })
  })

  it('rejects flushed and dispose on permanent injected IO failure', async () => {
    const io: ReceiptStoreIO = {
      mkdir: async () => {},
      writeFile: async () => {
        const error = new Error('EACCES') as NodeJS.ErrnoException
        error.code = 'EACCES'
        throw error
      },
      rename: async () => {},
    }
    const store = new FileReceiptStore('/tmp/unwritable-receipts.json', io)
    store.append(receipt('lost'))
    await expect(store.flushed()).rejects.toThrow(/EACCES/)
    await expect(store.dispose()).rejects.toThrow(/EACCES/)
  })

  it('retries a transient injected failure then flushes', async () => {
    let attempts = 0
    const io: ReceiptStoreIO = {
      mkdir: async () => {},
      writeFile: async () => {
        attempts += 1
        if (attempts < 3) throw new Error('EAGAIN')
      },
      rename: async () => {},
    }
    const store = new FileReceiptStore('/tmp/transient-receipts.json', io)
    store.append(receipt('recovered'))
    await store.flushed()
    expect(attempts).toBe(3)
    await store.dispose()
  })
})
