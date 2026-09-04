import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileReceiptStore } from '../src/receipts/store.ts'
import { RECEIPTS_PER_SESSION, type MutationReceipt } from '../src/receipts/types.ts'

function receipt(id: string, sessionPath = '/tmp/s.jsonl'): MutationReceipt {
  return { id, sessionPath, turn: 1, startedAt: 1, completedAt: 2, files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '' }], tools: [] }
}

describe('receipt store', () => {
  it('appends, caps per session, clears, and reloads from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heddlework-receipts-'))
    const path = join(dir, 'nested', 'receipts.json')
    const store = new FileReceiptStore(path)
    for (let index = 0; index < RECEIPTS_PER_SESSION + 5; index += 1) store.append(receipt(`R${index}`))
    store.append(receipt('other', '/tmp/other.jsonl'))
    expect(store.list('/tmp/s.jsonl')).toHaveLength(RECEIPTS_PER_SESSION)
    expect(store.list('/tmp/s.jsonl')[0]!.id).toBe('R5')

    const reloaded = new FileReceiptStore(path)
    expect(reloaded.list('/tmp/s.jsonl')).toHaveLength(RECEIPTS_PER_SESSION)
    expect(reloaded.list('/tmp/other.jsonl').map((entry) => entry.id)).toEqual(['other'])

    reloaded.clear('/tmp/s.jsonl')
    expect(reloaded.list('/tmp/s.jsonl')).toEqual([])
    expect(new FileReceiptStore(path).list('/tmp/s.jsonl')).toEqual([])
    expect(new FileReceiptStore(path).list('/tmp/other.jsonl')).toHaveLength(1)
    rmSync(dir, { recursive: true, force: true })
  })

  it('keeps working in memory when persistence is off', () => {
    const store = new FileReceiptStore(false)
    store.append(receipt('x'))
    expect(store.list('/tmp/s.jsonl').map((entry) => entry.id)).toEqual(['x'])
  })
})
