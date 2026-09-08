import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { RECEIPTS_PER_SESSION, type MutationReceipt } from './types.ts'

export interface ReceiptStoreService {
  list(sessionPath: string): MutationReceipt[]
  append(receipt: MutationReceipt): void
  clear(sessionPath: string): void
  flushed?(): Promise<void>
  dispose?(): Promise<void>
}

export interface ReceiptStoreIO {
  mkdir(path: string): Promise<void>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
}

interface ReceiptStoreDocument {
  version: 1
  sessions: Record<string, MutationReceipt[]>
}

const sharedStores = new Map<string, FileReceiptStore>()
export const RECEIPT_FLUSH_MAX_RETRIES = 8
export const RECEIPT_FLUSH_RETRY_MS = 250

const defaultIO: ReceiptStoreIO = {
  mkdir: async (path) => {
    await mkdir(path, { recursive: true })
  },
  writeFile,
  rename,
}

export function sharedReceiptStore(path: string | false, io?: ReceiptStoreIO): FileReceiptStore {
  if (path === false) return new FileReceiptStore(false, io)
  const existing = sharedStores.get(path)
  if (existing) return existing
  const store = new FileReceiptStore(path, io)
  sharedStores.set(path, store)
  return store
}

export class FileReceiptStore implements ReceiptStoreService {
  readonly #path: string | false
  readonly #io: ReceiptStoreIO
  #document: ReceiptStoreDocument
  #dirty = false
  #writing = false
  #lastError: Error | undefined
  #retry: ReturnType<typeof setTimeout> | undefined
  #retries = 0
  #failedPermanently = false
  #idleWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = []

  constructor(path: string | false = receiptStorePath(), io: ReceiptStoreIO = defaultIO) {
    this.#path = path
    this.#io = io
    this.#document = readDocument(path)
  }

  list(sessionPath: string): MutationReceipt[] {
    return [...(this.#document.sessions[sessionPath] ?? [])]
  }

  append(receipt: MutationReceipt): void {
    const existing = this.#document.sessions[receipt.sessionPath] ?? []
    const next = [...existing.filter((entry) => entry.id !== receipt.id), receipt]
    this.#document.sessions[receipt.sessionPath] = next.slice(Math.max(0, next.length - RECEIPTS_PER_SESSION))
    this.#scheduleFlush()
  }

  clear(sessionPath: string): void {
    if (!(sessionPath in this.#document.sessions)) return
    delete this.#document.sessions[sessionPath]
    this.#scheduleFlush()
  }

  flushed(): Promise<void> {
    if (this.#path === false) return Promise.resolve()
    if (this.#failedPermanently && this.#lastError) return Promise.reject(this.#lastError)
    if (!this.#dirty && !this.#writing) {
      return this.#lastError ? Promise.reject(this.#lastError) : Promise.resolve()
    }
    if (this.#dirty && !this.#writing) this.#scheduleFlush()
    return new Promise((resolve, reject) => {
      this.#idleWaiters.push({ resolve, reject })
    })
  }

  async dispose(): Promise<void> {
    if (this.#retry) {
      clearTimeout(this.#retry)
      this.#retry = undefined
    }
    if (this.#path !== false) {
      const shared = sharedStores.get(this.#path)
      if (shared === this) sharedStores.delete(this.#path)
    }
    if (this.#path === false) {
      this.#resolveWaiters()
      return
    }
    if (this.#dirty || this.#writing || this.#failedPermanently) {
      try {
        await this.#writeDocument()
        this.#dirty = false
        this.#lastError = undefined
        this.#failedPermanently = false
        this.#retries = 0
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.#lastError = failure
        this.#failedPermanently = true
        this.#rejectWaiters(failure)
        throw failure
      }
    }
    this.#resolveWaiters()
  }

  #scheduleFlush(): void {
    if (this.#path === false || this.#failedPermanently) return
    this.#dirty = true
    if (this.#writing) return
    this.#writing = true
    queueMicrotask(() => {
      void this.#drain()
    })
  }

  async #drain(): Promise<void> {
    try {
      while (this.#dirty && !this.#failedPermanently) {
        this.#dirty = false
        try {
          await this.#writeDocument()
          this.#lastError = undefined
          this.#retries = 0
        } catch (error) {
          this.#dirty = true
          const failure = error instanceof Error ? error : new Error(String(error))
          this.#lastError = failure
          if (isPermanentIoError(failure) || this.#retries >= RECEIPT_FLUSH_MAX_RETRIES) {
            this.#failedPermanently = true
            this.#rejectWaiters(failure)
            return
          }
          this.#retries += 1
          this.#retry = setTimeout(() => {
            this.#retry = undefined
            this.#scheduleFlush()
          }, RECEIPT_FLUSH_RETRY_MS)
          this.#retry.unref?.()
          return
        }
      }
      if (!this.#failedPermanently) this.#resolveWaiters()
    } finally {
      this.#writing = false
    }
  }

  async #writeDocument(): Promise<void> {
    if (!this.#path) return
    const temporary = `${this.#path}.${process.pid}.tmp`
    await this.#io.mkdir(dirname(this.#path))
    await this.#io.writeFile(temporary, JSON.stringify(this.#document))
    await this.#io.rename(temporary, this.#path)
  }

  #resolveWaiters(): void {
    const waiters = this.#idleWaiters.splice(0)
    for (const waiter of waiters) waiter.resolve()
  }

  #rejectWaiters(error: Error): void {
    const waiters = this.#idleWaiters.splice(0)
    for (const waiter of waiters) waiter.reject(error)
  }
}

export function receiptStorePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'receipts.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'receipts.json')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'receipts.json')
}

function isPermanentIoError(error: Error): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS' || code === 'ENOTDIR' || code === 'EISDIR'
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
