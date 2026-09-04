import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { RECEIPTS_PER_SESSION, type MutationReceipt } from './types.ts'

export interface ReceiptStoreService {
  list(sessionPath: string): MutationReceipt[]
  append(receipt: MutationReceipt): void
  clear(sessionPath: string): void
}

interface ReceiptStoreDocument {
  version: 1
  sessions: Record<string, MutationReceipt[]>
}

export class FileReceiptStore implements ReceiptStoreService {
  readonly #path: string | false
  #document: ReceiptStoreDocument

  constructor(path: string | false = receiptStorePath()) {
    this.#path = path
    this.#document = readDocument(path)
  }

  list(sessionPath: string): MutationReceipt[] {
    return [...(this.#document.sessions[sessionPath] ?? [])]
  }

  append(receipt: MutationReceipt): void {
    const existing = this.#document.sessions[receipt.sessionPath] ?? []
    const next = [...existing.filter((entry) => entry.id !== receipt.id), receipt]
    this.#document.sessions[receipt.sessionPath] = next.slice(Math.max(0, next.length - RECEIPTS_PER_SESSION))
    this.#flush()
  }

  clear(sessionPath: string): void {
    if (!(sessionPath in this.#document.sessions)) return
    delete this.#document.sessions[sessionPath]
    this.#flush()
  }

  #flush(): void {
    if (!this.#path) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(this.#document), 'utf8')
      renameSync(temporary, this.#path)
    } catch {
      // Receipts remain in memory when persistence is unavailable.
    }
  }
}

export function receiptStorePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'receipts.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'receipts.json')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'receipts.json')
}

function readDocument(path: string | false): ReceiptStoreDocument {
  if (!path) return { version: 1, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ReceiptStoreDocument>
    if (parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') return { version: 1, sessions: parsed.sessions }
  } catch {
    // Missing or corrupt store starts empty.
  }
  return { version: 1, sessions: {} }
}
