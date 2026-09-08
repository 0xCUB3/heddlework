import { open, stat } from 'node:fs/promises'
import type { PiMessage } from './types.ts'
import { formatTurnTelemetry } from '../workbench/telemetry.ts'
import {
  extractSessionLink,
  scanJsonlReverse,
  type JsonlRecordSpan,
  type ReverseJsonlRecord,
  type SessionRecordLink,
} from './session-history-scan.ts'

export const SESSION_HISTORY_PAGE_MESSAGES = 80
export const SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES = 12
export const SESSION_HISTORY_PAGE_MAX_MESSAGES = 1_200
export const SESSION_HISTORY_PAGE_BODY_BYTES = 512 * 1024
export const SESSION_HISTORY_RESERVED_TURN_BYTES = 64 * 1024
export const SESSION_HISTORY_PARSE_BYTES = 64 * 1024

interface PersistedSessionEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string | number
  message?: PiMessage
  customType?: string
  content?: PiMessage['content']
  display?: boolean
  summary?: string
  tokensBefore?: number
  data?: unknown
  details?: unknown
}

export interface SessionHistoryDetailRef {
  workbenchEntryId: string
  offset: number
  length: number
}

export interface SessionHistoryStub extends PiMessage {
  truncated: true
  detail: SessionHistoryDetailRef
}

export interface SessionHistoryPage {
  messages: PiMessage[]
  hasOlder: boolean
}

export interface SessionHistoryLoadOptions {
  minimumConversationMessages?: number
  maximumMessages?: number
  maximumBodyBytes?: number
  reservedTurnBytes?: number
}

export function isSessionHistoryStub(message: PiMessage): message is SessionHistoryStub {
  return message.truncated === true && isDetailRef(message.detail)
}

export class PiSessionHistoryPager {
  readonly #path: string
  readonly #spans = new Map<string, JsonlRecordSpan>()
  #scanEnd: number | undefined
  #targetId: string | null | undefined
  #done = false
  #queue: Promise<unknown> = Promise.resolve()

  constructor(path: string, targetId?: string | null) {
    this.#path = path
    if (targetId !== undefined) {
      this.#targetId = targetId
      if (targetId === null) this.#done = true
    }
  }

  async loadEarlier(
    limit = SESSION_HISTORY_PAGE_MESSAGES,
    options: SessionHistoryLoadOptions = {},
  ): Promise<SessionHistoryPage> {
    return this.#enqueue(() => this.#loadEarlierUnsync(limit, options))
  }

  async #loadEarlierUnsync(
    limit = SESSION_HISTORY_PAGE_MESSAGES,
    options: SessionHistoryLoadOptions = {},
  ): Promise<SessionHistoryPage> {
    if (this.#done || limit <= 0) return { messages: [], hasOlder: false }
    const minimumConversationMessages = Math.max(0, options.minimumConversationMessages ?? 0)
    const maximumMessages = Math.max(limit, options.maximumMessages ?? limit)
    const budgets = new PageBudgets(
      options.maximumBodyBytes ?? SESSION_HISTORY_PAGE_BODY_BYTES,
      options.reservedTurnBytes ?? SESSION_HISTORY_RESERVED_TURN_BYTES,
    )
    const file = await open(this.#path, 'r')
    try {
      if (this.#scanEnd === undefined) this.#scanEnd = (await stat(this.#path)).size
      let targetId = this.#targetId
      const messages: PiMessage[] = []
      let conversationMessages = 0

      const visit = (record: ReverseJsonlRecord): boolean => {
        const linked = this.#visitRecord(record, targetId, budgets)
        if (!linked) return false
        targetId = linked.targetId
        if (linked.message) {
          messages.push(linked.message)
          if (isConversationMessage(linked.message)) conversationMessages += 1
        }
        if (
          messages.length < limit
          || (conversationMessages < minimumConversationMessages && messages.length < maximumMessages)
        ) return false
        this.#scanEnd = record.offset
        this.#targetId = targetId
        return true
      }

      const scanned = await scanJsonlReverse(file, this.#scanEnd, visit)
      if (scanned.complete) {
        this.#scanEnd = 0
        this.#targetId = null
        this.#done = true
        return { messages: messages.reverse(), hasOlder: false }
      }
      return { messages: messages.reverse(), hasOlder: targetId !== null }
    } finally {
      await file.close()
    }
  }

  #enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work, work)
    this.#queue = run.then(() => undefined, () => undefined)
    return run
  }

  async loadEntry(id: string): Promise<PiMessage | undefined> {
    if (!id || id.startsWith('anon:')) return undefined
    return this.#enqueue(() => this.#loadEntryUnsync(id))
  }

  async #loadEntryUnsync(id: string): Promise<PiMessage | undefined> {
    if (!id) return undefined
    const file = await open(this.#path, 'r')
    try {
      const known = this.#spans.get(id)
      if (known) return readMessageAt(file, known)
      const size = (await stat(this.#path)).size
      let found: PiMessage | undefined
      await scanJsonlReverse(file, size, (record) => {
        const link = extractSessionLink(record)
        if (!link?.id) return false
        this.#spans.set(link.id, { offset: record.offset, length: record.length })
        if (link.id !== id) return false
        found = materializeFull(record)
        return true
      })
      return found
    } finally {
      await file.close()
    }
  }

  async loadMessageDetail(id: string): Promise<PiMessage | undefined> {
    return this.loadEntry(id)
  }

  #visitRecord(
    record: ReverseJsonlRecord,
    targetId: string | null | undefined,
    budgets: PageBudgets,
  ): { targetId: string | null; message?: PiMessage } | undefined {
    const small = record.length <= SESSION_HISTORY_PARSE_BYTES
    const entry = small ? parseEntry(record.bytes()) : undefined
    if (small && !entry) return undefined
    const link = entryToLink(entry) ?? extractSessionLink(record)
    if (!link?.id) return undefined
    this.#spans.set(link.id, { offset: record.offset, length: record.length })
    let nextTarget = targetId
    if (nextTarget === undefined) {
      if (!isVisibleLink(link, entry)) return undefined
      nextTarget = link.id
    }
    if (link.id !== nextTarget) return undefined
    const parent = typeof link.parentId === 'string' ? link.parentId : null
    const message = this.#pageMessage(record, link, entry, budgets)
    return { targetId: parent, ...(message ? { message } : {}) }
  }

  #pageMessage(
    record: ReverseJsonlRecord,
    link: SessionRecordLink,
    entry: PersistedSessionEntry | undefined,
    budgets: PageBudgets,
  ): PiMessage | undefined {
    if (!isVisibleLink(link, entry)) return undefined
    const role = messageRole(link, entry)
    const reserved = role ? budgets.reserveRole(role) : undefined
    const fits = budgets.canTake(record.length, reserved)
    if (entry && fits) {
      const message = persistedMessage(entry)
      if (message) budgets.take(record.length, reserved)
      return message
    }
    if (fits && record.length <= SESSION_HISTORY_PARSE_BYTES) {
      const parsed = parseEntry(record.bytes())
      const message = parsed ? persistedMessage(parsed) : undefined
      if (message) budgets.take(record.length, reserved)
      return message
    }
    const stub = stubFromLink(link, record)
    if (stub && reserved) budgets.noteReserved(reserved)
    return stub
  }
}

class PageBudgets {
  general: number
  reservedUser: number
  reservedAssistant: number
  seenUser = false
  seenAssistant = false

  constructor(bodyBytes: number, reservedTurnBytes: number) {
    this.reservedUser = Math.max(0, reservedTurnBytes)
    this.reservedAssistant = Math.max(0, reservedTurnBytes)
    this.general = Math.max(0, bodyBytes - this.reservedUser - this.reservedAssistant)
  }

  reserveRole(role: string): 'user' | 'assistant' | undefined {
    if (role === 'user' && !this.seenUser) return 'user'
    if (role === 'assistant' && !this.seenAssistant) return 'assistant'
    return undefined
  }

  canTake(size: number, reserve?: 'user' | 'assistant'): boolean {
    if (reserve) return size <= (reserve === 'user' ? this.reservedUser : this.reservedAssistant) + this.general
    return size <= this.general
  }

  take(size: number, reserve?: 'user' | 'assistant'): void {
    if (reserve) {
      this.noteReserved(reserve)
      const pocket = reserve === 'user' ? this.reservedUser : this.reservedAssistant
      const fromPocket = Math.min(size, pocket)
      if (reserve === 'user') this.reservedUser -= fromPocket
      else this.reservedAssistant -= fromPocket
      this.general -= size - fromPocket
      this.#releaseIfReady()
      return
    }
    this.general -= size
  }

  noteReserved(reserve: 'user' | 'assistant'): void {
    if (reserve === 'user') this.seenUser = true
    else this.seenAssistant = true
    this.#releaseIfReady()
  }

  #releaseIfReady(): void {
    if (!this.seenUser || !this.seenAssistant) return
    this.general += this.reservedUser + this.reservedAssistant
    this.reservedUser = 0
    this.reservedAssistant = 0
  }
}

function isDetailRef(value: unknown): value is SessionHistoryDetailRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as SessionHistoryDetailRef
  return typeof ref.workbenchEntryId === 'string' && typeof ref.offset === 'number' && typeof ref.length === 'number'
}

function entryToLink(entry: PersistedSessionEntry | undefined): SessionRecordLink | undefined {
  if (!entry?.id) return undefined
  const role = entry.message && typeof entry.message.role === 'string' ? entry.message.role : undefined
  return {
    id: entry.id,
    parentId: typeof entry.parentId === 'string' ? entry.parentId : null,
    ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
    ...(typeof entry.display === 'boolean' ? { display: entry.display } : {}),
    ...(typeof entry.customType === 'string' ? { customType: entry.customType } : {}),
    ...(role ? { role } : {}),
    ...(typeof entry.message?.toolName === 'string' ? { toolName: entry.message.toolName } : {}),
    ...(typeof entry.message?.toolCallId === 'string' ? { toolCallId: entry.message.toolCallId } : {}),
  }
}

function isVisibleLink(link: SessionRecordLink, entry: PersistedSessionEntry | undefined): boolean {
  if (entry) return persistedMessage(entry) !== undefined
  if (link.type === 'message') return typeof link.role === 'string'
  if (link.type === 'compaction') return true
  if (link.type === 'custom_message') return link.display === true
  return false
}

function messageRole(link: SessionRecordLink, entry: PersistedSessionEntry | undefined): string | undefined {
  if (entry?.message && typeof entry.message.role === 'string') return entry.message.role
  if (link.role) return link.role
  if (link.type === 'compaction') return 'compaction'
  if (link.type === 'custom_message') return 'custom'
  return undefined
}

function stubFromLink(link: SessionRecordLink, record: ReverseJsonlRecord): SessionHistoryStub | undefined {
  if (!link.id) return undefined
  const role = link.role ?? (link.type === 'compaction' ? 'compaction' : link.type === 'custom_message' ? 'custom' : 'toolResult')
  return {
    role,
    workbenchEntryId: link.id,
    truncated: true,
    detail: { workbenchEntryId: link.id, offset: record.offset, length: record.length },
    ...(link.toolName ? { toolName: link.toolName } : {}),
    ...(link.toolCallId ? { toolCallId: link.toolCallId } : {}),
    ...(link.customType ? { customType: link.customType } : {}),
  }
}

function materializeFull(record: ReverseJsonlRecord): PiMessage | undefined {
  const entry = parseEntry(record.bytes())
  return entry ? persistedMessage(entry) : undefined
}

async function readMessageAt(file: Awaited<ReturnType<typeof open>>, span: JsonlRecordSpan): Promise<PiMessage | undefined> {
  const buffer = Buffer.allocUnsafe(span.length)
  const { bytesRead } = await file.read(buffer, 0, buffer.length, span.offset)
  const entry = parseEntry(buffer.subarray(0, bytesRead))
  return entry ? persistedMessage(entry) : undefined
}

function parseEntry(line: Buffer): PersistedSessionEntry | undefined {
  try {
    const value = JSON.parse(line.toString('utf8')) as unknown
    return value && typeof value === 'object' ? value as PersistedSessionEntry : undefined
  } catch {
    return undefined
  }
}

function persistedMessage(entry: PersistedSessionEntry): PiMessage | undefined {
  if (entry.type === 'custom') {
    const text = formatTurnTelemetry(entry.data)
    if (!text) return undefined
    const timestamp = persistedTimestamp(entry.timestamp)
    return { role: 'telemetry', content: text, workbenchEntryId: entry.id, ...(timestamp === undefined ? {} : { timestamp }) }
  }
  if (entry.type === 'message' && entry.message && typeof entry.message.role === 'string') {
    return { ...entry.message, workbenchEntryId: entry.id }
  }
  if (entry.type === 'compaction') {
    if (typeof entry.summary !== 'string' || !entry.summary) return undefined
    const timestamp = persistedTimestamp(entry.timestamp)
    return {
      role: 'compaction',
      content: entry.summary,
      display: true,
      workbenchEntryId: entry.id,
      ...(typeof entry.tokensBefore === 'number' ? { tokensBefore: entry.tokensBefore } : {}),
      ...(timestamp === undefined ? {} : { timestamp }),
    }
  }
  if (entry.type !== 'custom_message' || entry.display !== true) return undefined
  const timestamp = persistedTimestamp(entry.timestamp)
  return {
    role: 'custom',
    display: true,
    workbenchEntryId: entry.id,
    ...(entry.details === undefined ? {} : { details: entry.details }),
    ...(entry.customType === undefined ? {} : { customType: entry.customType }),
    ...(entry.content === undefined ? {} : { content: entry.content }),
    ...(timestamp === undefined ? {} : { timestamp }),
  }
}

function isConversationMessage(message: PiMessage): boolean {
  if (message.role === 'user') return true
  if (message.role !== 'assistant') return false
  if (typeof message.content === 'string') return message.content.trim().length > 0
  return Array.isArray(message.content) && message.content.some((block) => (
    block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0
  ))
}

function persistedTimestamp(value: string | number | undefined): number | undefined {
  if (typeof value === 'number') return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}
