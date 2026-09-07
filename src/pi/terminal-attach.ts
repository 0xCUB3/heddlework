import { realpathSync } from 'node:fs'
import { normalize, resolve } from 'node:path'
import type { PiLiveBridgeAdvertisement } from './live-bridge.ts'
import type { RpcRecord } from './types.ts'

export const TERMINAL_ATTACH_HISTORY_LIMIT = 40
export const TERMINAL_ATTACH_HISTORY_CHAR_BUDGET = 64 * 1024
export const TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT = 16 * 1024
export const TERMINAL_ATTACH_STREAM_INTERVAL_MS = 50

export function parseTerminalAttachArguments(args: readonly string[]): { list: boolean; help: boolean; session?: string } {
  const result: { list: boolean; help: boolean; session?: string } = { list: false, help: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--') continue
    if (arg === '--list') result.list = true
    else if (arg === '--help' || arg === '-h') result.help = true
    else if (arg === '--session') {
      const value = args[++index]
      if (!value || value.startsWith('--')) throw new Error('--session requires a path')
      if (result.session !== undefined) throw new Error('Specify --session only once')
      result.session = value
    } else throw new Error(`Unknown argument: ${arg}`)
  }
  if (result.list && result.session !== undefined) throw new Error('Use --list or --session, not both')
  return result
}

export interface TerminalAttachSelection {
  advertisement: PiLiveBridgeAdvertisement
  normalizedSessionFile?: string | undefined
}

export function normalizeSessionPath(path: string): string {
  let normalized = normalize(resolve(path))
  try { normalized = realpathSync(normalized) } catch { /* Pi may not have written its first message yet. */ }
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export function selectTerminalAttachBridge(
  advertisements: readonly PiLiveBridgeAdvertisement[],
  requestedSession?: string,
): TerminalAttachSelection {
  if (advertisements.length === 0) throw new Error('No live Pi sessions are available to attach')
  if (!requestedSession) {
    if (advertisements.length !== 1) throw new Error(`Multiple live Pi sessions are available (${advertisements.length}); choose one with --session <path>`)
    const advertisement = advertisements[0]!
    return { advertisement, ...(advertisement.sessionFile ? { normalizedSessionFile: normalizeSessionPath(advertisement.sessionFile) } : {}) }
  }
  const target = normalizeSessionPath(requestedSession)
  const matches = advertisements.filter((candidate) => candidate.sessionFile && normalizeSessionPath(candidate.sessionFile) === target)
  if (matches.length === 0) throw new Error(`No live Pi session matches ${target}`)
  if (matches.length > 1) throw new Error(`Multiple live Pi sessions match ${target}`)
  return { advertisement: matches[0]!, normalizedSessionFile: target }
}

export function terminalAttachListLine(advertisement: PiLiveBridgeAdvertisement): string {
  const path = advertisement.sessionFile ? singleLine(normalizeSessionPath(advertisement.sessionFile)) : '(session file unavailable)'
  const name = advertisement.sessionName ? ` · ${singleLine(advertisement.sessionName)}` : ''
  const streaming = advertisement.isStreaming ? ' · streaming' : ''
  return `${path} · pid ${advertisement.pid} · ${singleLine(advertisement.cwd)}${name}${streaming}`
}

export function sanitizeTerminalText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1bP[\s\S]*?\x1b\\/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // Preserve code formatting without allowing cursor movement, clipboard
    // writes, or title changes supplied by a model or tool.
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

function singleLine(value: string): string {
  return boundedTerminalText(value).replace(/[\n\t]/g, ' ')
}

export function boundedTerminalText(value: string, limit = TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT): string {
  const sanitized = sanitizeTerminalText(value)
  if (limit <= 0) return ''
  return sanitized.length <= limit ? sanitized : `${sanitized.slice(0, Math.max(0, limit - 1))}…`
}

export function messageText(message: unknown, limit = TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT): string {
  if (!message || typeof message !== 'object') return ''
  const value = message as { content?: unknown }
  if (typeof value.content === 'string') return boundedTerminalText(value.content, limit)
  if (!Array.isArray(value.content)) return ''
  return boundedTerminalText(value.content.flatMap((block) => {
    if (!block || typeof block !== 'object') return []
    const candidate = block as { text?: unknown; thinking?: unknown }
    if (typeof candidate.text === 'string') return [candidate.text]
    if (typeof candidate.thinking === 'string') return [candidate.thinking]
    return []
  }).join('\n'), limit)
}

export function boundedInitialHistory(
  messages: readonly unknown[],
  limit = TERMINAL_ATTACH_HISTORY_LIMIT,
): unknown[] {
  const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : TERMINAL_ATTACH_HISTORY_LIMIT
  return count === 0 ? [] : messages.slice(-count)
}

export function boundedInitialHistoryLines(
  messages: readonly unknown[],
  limit = TERMINAL_ATTACH_HISTORY_LIMIT,
  charBudget = TERMINAL_ATTACH_HISTORY_CHAR_BUDGET,
): string[] {
  if (limit <= 0 || charBudget <= 0) return []
  const selected = boundedInitialHistory(messages, limit)
  const lines: string[] = []
  let remaining = charBudget
  for (let index = selected.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = selected[index]
    const role = message && typeof message === 'object'
      ? singleLine(String((message as { role?: unknown }).role ?? 'message'))
      : 'message'
    const prefix = `${role}: `
    const text = messageText(message, Math.min(TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT, Math.max(0, remaining - prefix.length)))
    if (!text) continue
    const line = `${prefix}${text}`
    lines.push(line)
    remaining -= line.length
  }
  return lines.reverse()
}

export class TerminalAttachEventFormatter {
  readonly #write: (text: string) => void
  readonly #intervalMs: number
  #pendingAssistant = ''
  readonly #pendingTools = new Map<string, RpcRecord>()
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(write: (text: string) => void, intervalMs = TERMINAL_ATTACH_STREAM_INTERVAL_MS) {
    this.#write = write
    this.#intervalMs = intervalMs
  }

  handle(event: RpcRecord): void {
    if (event.type === 'message_start') {
      this.flush()
      const message = event.message as { role?: unknown } | undefined
      const text = messageText(event.message)
      if (message?.role === 'user' && text) this.#write(`user: ${text}`)
      else if (message?.role === 'assistant' && text) this.#queueAssistant(text)
      return
    }
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent as { type?: unknown; delta?: unknown } | undefined
      if ((delta?.type === 'text_delta' || delta?.type === 'thinking_delta') && typeof delta.delta === 'string') this.#queueAssistant(delta.delta)
      return
    }
    if (event.type === 'message_end') {
      this.flush()
      return
    }
    if (event.type === 'tool_execution_start') {
      this.flush()
      this.#write(`tool: ${singleLine(String(event.toolName ?? 'tool'))}`)
      return
    }
    if (event.type === 'tool_execution_update') {
      // Tool updates are cumulative snapshots, so only paint the latest one per
      // tool on each tick rather than repeatedly printing the entire output.
      const id = String(event.toolCallId ?? event.toolName ?? 'tool')
      this.#pendingTools.set(id, event)
      if (this.#pendingTools.size >= 128) this.flush()
      else this.#schedule()
      return
    }
    if (event.type === 'tool_execution_end') {
      this.#pendingTools.delete(String(event.toolCallId ?? event.toolName ?? 'tool'))
      this.flush()
      const result = event.result as { content?: unknown } | undefined
      const text = messageText(result)
      if (text) this.#write(`tool result: ${text}`)
      return
    }
    if (event.type === 'session_info_changed') {
      const name = event.sessionName
      if (typeof name === 'string' && name.trim()) this.#write(`session: ${singleLine(name.trim())}`)
      return
    }
    if (event.type === 'session_switched') {
      this.flush()
      const state = event.state as { sessionName?: unknown; sessionId?: unknown } | undefined
      this.#write(`session: ${singleLine(String(state?.sessionName ?? state?.sessionId ?? 'changed'))}`)
    } else if (event.type === 'agent_settled') {
      this.flush()
    }
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = undefined
    const text = boundedTerminalText(this.#pendingAssistant)
    this.#pendingAssistant = ''
    if (text) this.#write(`assistant: ${text}`)
    for (const event of this.#pendingTools.values()) {
      const text = messageText(event.partialResult)
      this.#write(`tool: ${singleLine(String(event.toolName ?? 'tool'))} (running)${text ? `\n${text}` : ''}`)
    }
    this.#pendingTools.clear()
  }

  dispose(): void { this.flush() }

  #queueAssistant(value: string): void {
    // Flush large deltas in bounded chunks instead of allocating an unbounded
    // staging string or truncating everything beyond one timer's text budget.
    let offset = 0
    while (offset < value.length) {
      const count = Math.min(value.length - offset, TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT - this.#pendingAssistant.length)
      this.#pendingAssistant += value.slice(offset, offset + count)
      offset += count
      if (this.#pendingAssistant.length >= TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT) this.flush()
    }
    this.#schedule()
  }

  #schedule(): void {
    if (this.#timer) return
    this.#timer = setTimeout(() => this.flush(), this.#intervalMs)
  }
}
