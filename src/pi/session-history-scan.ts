import type { FileHandle } from 'node:fs/promises'

export const REVERSE_SCAN_CHUNK_BYTES = 256 * 1024
export const SESSION_HISTORY_LINK_PEEK_BYTES = 32 * 1024

export interface JsonlRecordSpan {
  offset: number
  length: number
}

export interface SessionRecordLink {
  id?: string
  parentId?: string | null
  type?: string
  display?: boolean
  role?: string
  toolName?: string
  toolCallId?: string
  customType?: string
}

export interface ReverseJsonlRecord extends JsonlRecordSpan {
  prefix(maxBytes?: number): Buffer
  suffix(maxBytes?: number): Buffer
  bytes(): Buffer
}

/** Scan JSONL from `end` toward offset 0. Each byte is read once; a completed line is joined only if a visitor asks for `bytes()`. */
export async function scanJsonlReverse(
  file: FileHandle,
  end: number,
  visit: (record: ReverseJsonlRecord) => boolean | Promise<boolean>,
): Promise<{ position: number; complete: boolean }> {
  let position = end
  const suffix: Buffer[] = []
  while (position > 0) {
    const chunkStart = Math.max(0, position - REVERSE_SCAN_CHUNK_BYTES)
    const chunk = Buffer.allocUnsafe(position - chunkStart)
    const { bytesRead } = await file.read(chunk, 0, chunk.length, chunkStart)
    const data = bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead)
    let lineEnd = data.length
    for (let index = data.length - 1; index >= 0; index -= 1) {
      if (data[index] !== 0x0a) continue
      if (index + 1 < lineEnd || suffix.length > 0) {
        const head = data.subarray(index + 1, lineEnd)
        const parts = suffix.length === 0 ? [head] : [head, ...suffix]
        const length = parts.reduce((total, part) => total + part.length, 0)
        if (length > 0) {
          const record = makeRecord(chunkStart + index + 1, length, parts)
          if (await visit(record)) return { position: chunkStart + index + 1, complete: false }
        }
      }
      suffix.length = 0
      lineEnd = index
    }
    if (lineEnd > 0) suffix.unshift(data.subarray(0, lineEnd))
    position = chunkStart
  }
  if (suffix.length > 0) {
    const length = suffix.reduce((total, part) => total + part.length, 0)
    if (length > 0) await visit(makeRecord(0, length, suffix))
  }
  return { position: 0, complete: true }
}

export function extractSessionLink(record: ReverseJsonlRecord): SessionRecordLink | undefined {
  if (record.length === 0) return undefined
  if (record.length <= SESSION_HISTORY_LINK_PEEK_BYTES * 2) return parseLink(record.bytes().toString('utf8'))
  const head = parseLink(record.prefix().toString('utf8')) ?? {}
  const tailText = record.suffix(2048).toString('utf8')
  if (head.display === undefined) {
    const display = /"display"\s*:\s*(true|false)/.exec(tailText)
    if (display) head.display = display[1] === 'true'
  }
  if (!head.id) {
    const id = /"id"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(tailText)
    if (id) head.id = unescapeJsonString(id[1]!)
  }
  if (head.parentId === undefined) {
    const parent = /"parentId"\s*:\s*(null|"((?:\\.|[^"\\])*)")/.exec(tailText)
    if (parent) head.parentId = parent[1] === 'null' ? null : unescapeJsonString(parent[2] ?? '')
  }
  return head.id || head.type ? head : undefined
}

function makeRecord(offset: number, length: number, parts: Buffer[]): ReverseJsonlRecord {
  return {
    offset,
    length,
    prefix(maxBytes = SESSION_HISTORY_LINK_PEEK_BYTES) {
      return takePrefix(parts, maxBytes)
    },
    suffix(maxBytes = SESSION_HISTORY_LINK_PEEK_BYTES) {
      return takeSuffix(parts, maxBytes)
    },
    bytes() {
      return parts.length === 1 ? parts[0]! : Buffer.concat(parts)
    },
  }
}

function takePrefix(parts: readonly Buffer[], maxBytes: number): Buffer {
  let remaining = maxBytes
  const out: Buffer[] = []
  for (const part of parts) {
    if (remaining <= 0) break
    if (part.length <= remaining) {
      out.push(part)
      remaining -= part.length
    } else {
      out.push(part.subarray(0, remaining))
      remaining = 0
    }
  }
  if (out.length === 0) return Buffer.alloc(0)
  return out.length === 1 ? out[0]! : Buffer.concat(out)
}

function takeSuffix(parts: readonly Buffer[], maxBytes: number): Buffer {
  let remaining = maxBytes
  const out: Buffer[] = []
  for (let index = parts.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const part = parts[index]!
    if (part.length <= remaining) {
      out.unshift(part)
      remaining -= part.length
    } else {
      out.unshift(part.subarray(part.length - remaining))
      remaining = 0
    }
  }
  if (out.length === 0) return Buffer.alloc(0)
  return out.length === 1 ? out[0]! : Buffer.concat(out)
}

function parseLink(text: string): SessionRecordLink | undefined {
  const start = skipWs(text, 0)
  if (text[start] !== '{') return undefined
  const link: SessionRecordLink = {}
  let index = start + 1
  let depth = 1
  let inMessage = false
  while (index < text.length && depth > 0) {
    index = skipWs(text, index)
    if (index >= text.length) break
    const char = text[index]
    if (char === '}' || char === ']') {
      if (char === '}' && inMessage && depth === 2) inMessage = false
      depth -= 1
      index += 1
      continue
    }
    if (char === ',') {
      index += 1
      continue
    }
    if (char !== '"') {
      const skipped = skipValue(text, index)
      if (skipped === undefined) break
      index = skipped
      continue
    }
    const key = parseJsonString(text, index)
    if (!key) break
    index = skipWs(text, key.next)
    if (text[index] !== ':') break
    index = skipWs(text, index + 1)
    const top = depth === 1
    if (top && key.value === 'message' && text[index] === '{') {
      inMessage = true
      depth += 1
      index += 1
      continue
    }
    const capture = (top && isLinkKey(key.value)) || (inMessage && depth === 2 && isMessageKey(key.value))
    if (capture) {
      const value = parseJsonValue(text, index)
      if (!value) break
      assignLink(link, key.value, value.value)
      index = value.next
      continue
    }
    const skipped = skipValue(text, index)
    if (skipped === undefined) break
    index = skipped
  }
  return link.id || link.type ? link : undefined
}

function isLinkKey(key: string): boolean {
  return key === 'id' || key === 'parentId' || key === 'type' || key === 'display' || key === 'customType'
}

function isMessageKey(key: string): boolean {
  return key === 'role' || key === 'toolName' || key === 'toolCallId'
}

function assignLink(link: SessionRecordLink, key: string, value: unknown): void {
  if (key === 'parentId') {
    link.parentId = typeof value === 'string' ? value : null
    return
  }
  if (key === 'display' && typeof value === 'boolean') {
    link.display = value
    return
  }
  if (typeof value !== 'string') return
  if (key === 'id') link.id = value
  else if (key === 'type') link.type = value
  else if (key === 'customType') link.customType = value
  else if (key === 'role') link.role = value
  else if (key === 'toolName') link.toolName = value
  else if (key === 'toolCallId') link.toolCallId = value
}

function parseJsonValue(text: string, start: number): { value: unknown; next: number } | undefined {
  const index = skipWs(text, start)
  const char = text[index]
  if (char === '"') return parseJsonString(text, index)
  if (char === 't' && text.startsWith('true', index)) return { value: true, next: index + 4 }
  if (char === 'f' && text.startsWith('false', index)) return { value: false, next: index + 5 }
  if (char === 'n' && text.startsWith('null', index)) return { value: null, next: index + 4 }
  return undefined
}

function parseJsonString(text: string, start: number): { value: string; next: number } | undefined {
  if (text[start] !== '"') return undefined
  let index = start + 1
  let out = ''
  while (index < text.length) {
    const char = text[index++]!
    if (char === '"') return { value: out, next: index }
    if (char !== '\\') {
      out += char
      continue
    }
    if (index >= text.length) return undefined
    const next = text[index++]!
    if (next === 'u') {
      if (index + 4 > text.length) return undefined
      out += String.fromCharCode(Number.parseInt(text.slice(index, index + 4), 16))
      index += 4
      continue
    }
    const escaped: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
    out += escaped[next] ?? next
  }
  return undefined
}

function skipValue(text: string, start: number): number | undefined {
  const index = skipWs(text, start)
  const char = text[index]
  if (char === undefined) return undefined
  if (char === '"') return skipJsonString(text, index)
  if (char === '{') return skipDelimited(text, index, 0x7b, 0x7d)
  if (char === '[') return skipDelimited(text, index, 0x5b, 0x5d)
  if (char === 't' && text.startsWith('true', index)) return index + 4
  if (char === 'f' && text.startsWith('false', index)) return index + 5
  if (char === 'n' && text.startsWith('null', index)) return index + 4
  if (char === '-' || (char >= '0' && char <= '9')) {
    let cursor = index + 1
    while (cursor < text.length) {
      const next = text[cursor]!
      if ((next >= '0' && next <= '9') || next === '.' || next === 'e' || next === 'E' || next === '+' || next === '-') cursor += 1
      else break
    }
    return cursor
  }
  return undefined
}

function skipJsonString(text: string, start: number): number | undefined {
  let index = start + 1
  while (index < text.length) {
    const char = text[index++]!
    if (char === '"') return index
    if (char === '\\') {
      if (index >= text.length) return undefined
      index += 1
    }
  }
  return undefined
}

function skipDelimited(text: string, start: number, open: number, close: number): number | undefined {
  let depth = 1
  let index = start + 1
  let inString = false
  let escape = false
  while (index < text.length && depth > 0) {
    const code = text.charCodeAt(index++)
    if (inString) {
      if (escape) escape = false
      else if (code === 0x5c) escape = true
      else if (code === 0x22) inString = false
      continue
    }
    if (code === 0x22) {
      inString = true
      continue
    }
    if (code === open) depth += 1
    else if (code === close) depth -= 1
  }
  return depth === 0 ? index : undefined
}

function skipWs(text: string, index: number): number {
  while (index < text.length) {
    const char = text[index]
    if (char !== ' ' && char !== '\t' && char !== '\n' && char !== '\r') break
    index += 1
  }
  return index
}

function unescapeJsonString(value: string): string {
  return value.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))).replace(/\\(["\\/bfnrt])/g, (_, char: string) => {
    const escaped: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }
    return escaped[char] ?? char
  })
}
