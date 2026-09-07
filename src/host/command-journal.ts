import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WorkbenchCommand } from '../protocol/commands.ts'
import { commandAdmissionFingerprint } from './command-fingerprint.ts'

const ADMISSION_COMMANDS = new Set<WorkbenchCommand['type']>([
  'submit',
  'queueInput',
  'steerQueuedInput',
  'respondToDialog',
  'submitAskUserQuestionnaire',
  'newSession',
  'switchSession',
  'switchWorkspace',
  'navigateTree',
  'cloneSession',
  'drainQueueMessages',
  'pause',
  'abort',
  'compact',
  'launchFlow',
  'runFlowScheduleNow',
])

export class CommandJournalPersistError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = 'CommandJournalPersistError'
  }
}

export interface CommandAdmissionRecord {
  ok: boolean
  fingerprint: string
  value?: unknown
  error?: string
}

interface CommandJournalDocument {
  version: 1
  entries: Record<string, CommandAdmissionRecord>
}

export class CommandJournal {
  readonly #path: string | false
  #entries: Map<string, CommandAdmissionRecord>

  constructor(path: string | false) {
    this.#path = path
    this.#entries = readDocument(path)
  }

  static key(clientId: string, requestId: string): string {
    return clientId + ':' + requestId
  }

  needsAdmission(command: WorkbenchCommand): boolean {
    return ADMISSION_COMMANDS.has(command.type)
  }

  hasInFlight(): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.error === 'in-flight') return true
    }
    return false
  }

  lookup(clientId: string, requestId: string): CommandAdmissionRecord | undefined {
    return this.#entries.get(CommandJournal.key(clientId, requestId))
  }

  admit(clientId: string, requestId: string, fingerprint: string): void {
    const key = CommandJournal.key(clientId, requestId)
    if (this.#entries.has(key)) return
    this.#entries.set(key, { ok: false, error: 'in-flight', fingerprint })
    this.#persist()
  }

  complete(clientId: string, requestId: string, record: Omit<CommandAdmissionRecord, 'fingerprint'> & { fingerprint?: string | undefined }): void {
    const key = CommandJournal.key(clientId, requestId)
    const prior = this.#entries.get(key)
    const fingerprint = record.fingerprint ?? prior?.fingerprint ?? ''
    this.#entries.set(key, { ...record, fingerprint })
    this.#trim()
    this.#persist()
  }

  fingerprint(command: WorkbenchCommand, sessionKey?: string | undefined): string {
    return commandAdmissionFingerprint(command, sessionKey)
  }

  #trim(max = 500): void {
    for (const entry of this.#entries.values()) {
      if (entry.ok && entry.value !== undefined) entry.value = undefined
    }
    while (this.#entries.size > max) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      const entry = this.#entries.get(oldest)
      if (!entry) {
        this.#entries.delete(oldest)
        continue
      }
      if (entry.error === 'in-flight') break
      if (entry.error === 'expired') {
        this.#entries.delete(oldest)
        continue
      }
      this.#entries.set(oldest, { ok: false, error: 'expired', fingerprint: entry.fingerprint })
    }
  }

  #persist(): void {
    if (!this.#path) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temporary = this.#path + '.' + String(process.pid) + '.tmp'
      const payload: CommandJournalDocument = {
        version: 1,
        entries: Object.fromEntries(this.#entries.entries()),
      }
      writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', { mode: 0o600 })
      renameSync(temporary, this.#path)
    } catch (cause) {
      throw new CommandJournalPersistError(cause)
    }
  }
}

function readDocument(path: string | false): Map<string, CommandAdmissionRecord> {
  if (!path) return new Map()
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as CommandJournalDocument
    if (value.version !== 1 || !value.entries || typeof value.entries !== 'object') return new Map()
    return new Map(Object.entries(value.entries).map(([key, entry]) => [key, { ...entry, fingerprint: entry.fingerprint ?? '' }]))
  } catch {
    return new Map()
  }
}

