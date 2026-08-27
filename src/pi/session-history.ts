import { open, stat } from 'node:fs/promises'
import type { PiMessage } from './types.ts'

const REVERSE_SCAN_CHUNK_BYTES = 256 * 1024
export const SESSION_HISTORY_PAGE_MESSAGES = 80
export const SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES = 12
export const SESSION_HISTORY_PAGE_MAX_MESSAGES = 1_200

interface PersistedSessionEntry {
  type?: string
  id?: string
  parentId?: string | null
  timestamp?: string | number
  message?: PiMessage
  customType?: string
  content?: PiMessage['content']
  display?: boolean
}

export interface SessionHistoryPage {
  messages: PiMessage[]
  hasOlder: boolean
}

export interface SessionHistoryLoadOptions {
  minimumConversationMessages?: number
  maximumMessages?: number
}

export class PiSessionHistoryPager {
  readonly #path: string
  #scanEnd: number | undefined
  #targetId: string | null | undefined
  #done = false

  constructor(path: string) {
    this.#path = path
  }

  async loadEarlier(
    limit = SESSION_HISTORY_PAGE_MESSAGES,
    options: SessionHistoryLoadOptions = {},
  ): Promise<SessionHistoryPage> {
    if (this.#done || limit <= 0) return { messages: [], hasOlder: false }
    const minimumConversationMessages = Math.max(0, options.minimumConversationMessages ?? 0)
    const maximumMessages = Math.max(limit, options.maximumMessages ?? limit)
    const file = await open(this.#path, 'r')
    try {
      if (this.#scanEnd === undefined) this.#scanEnd = (await stat(this.#path)).size
      let position = this.#scanEnd
      let suffix = Buffer.alloc(0)
      let targetId = this.#targetId
      const messages: PiMessage[] = []
      let conversationMessages = 0

      const visit = (line: Buffer, lineStart: number): boolean => {
        const entry = parseEntry(line)
        if (!entry?.id) return false
        if (targetId === undefined) targetId = entry.id
        if (entry.id !== targetId) return false
        targetId = typeof entry.parentId === 'string' ? entry.parentId : null
        const message = persistedMessage(entry)
        if (message) {
          messages.push(message)
          if (isConversationMessage(message)) conversationMessages += 1
        }
        if (
          messages.length < limit
          || (conversationMessages < minimumConversationMessages && messages.length < maximumMessages)
        ) return false
        this.#scanEnd = lineStart
        this.#targetId = targetId
        return true
      }

      while (position > 0) {
        const chunkStart = Math.max(0, position - REVERSE_SCAN_CHUNK_BYTES)
        const chunk = Buffer.allocUnsafe(position - chunkStart)
        const { bytesRead } = await file.read(chunk, 0, chunk.length, chunkStart)
        const data = Buffer.concat([chunk.subarray(0, bytesRead), suffix])
        let lineEnd = data.length
        for (let index = data.length - 1; index >= 0; index -= 1) {
          if (data[index] !== 0x0a) continue
          if (index + 1 < lineEnd && visit(data.subarray(index + 1, lineEnd), chunkStart + index + 1)) {
            return { messages: messages.reverse(), hasOlder: targetId !== null }
          }
          lineEnd = index
        }
        suffix = data.subarray(0, lineEnd)
        position = chunkStart
      }

      if (suffix.length > 0) visit(suffix, 0)
      this.#scanEnd = 0
      this.#targetId = null
      this.#done = true
      return { messages: messages.reverse(), hasOlder: false }
    } finally {
      await file.close()
    }
  }
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
  if (entry.type === 'message' && entry.message && typeof entry.message.role === 'string') {
    return { ...entry.message, workbenchEntryId: entry.id }
  }
  if (entry.type !== 'custom_message' || entry.display !== true) return undefined
  const timestamp = persistedTimestamp(entry.timestamp)
  return {
    role: 'custom',
    display: true,
    workbenchEntryId: entry.id,
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
