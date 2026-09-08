import type { PiContentBlock, PiMessage } from '../pi/types.ts'
import type { LiveAssistant, LiveBlock, ToolRun } from '../workbench/state.ts'
import { dropUtf8Prefix, sliceUtf8Progress, tailUtf8, utf8ByteLength } from './frames.ts'
import type { LiveContentOp, WorkbenchSnapshot } from './snapshot.ts'

// Count windows (80/240/1200) are not byte budgets. These caps apply before a snapshot is serialized.
export const TRANSCRIPT_WIRE_BUDGET_BYTES = 1.5 * 1024 * 1024
export const TRANSCRIPT_BODY_BUDGET_BYTES = 8 * 1024
export const TRANSCRIPT_RESERVED_TAIL_BYTES = 64 * 1024
export const TRANSCRIPT_PREVIEW_CHARS = 240
export const TRANSCRIPT_DETAIL_PAGE_BYTES = 512 * 1024
export const TRANSCRIPT_DETAIL_MAX_PAGES = 256
export const TRANSCRIPT_DETAIL_AUTO_MAX_BYTES = 2 * 1024 * 1024
export const TRANSCRIPT_DETAIL_PREFETCH_CONCURRENCY = 2
export const TRANSCRIPT_MAX_STUB_BLOCKS = 4
export const TRANSCRIPT_STUB_META_CHARS = 96
export const TRANSCRIPT_MAX_LIVE_BLOCKS = 48
export const TRANSCRIPT_MAX_LIVE_TOOLS = 256
export const TRANSCRIPT_EXPANSION_CACHE_MAX = 24
export const TRANSCRIPT_EXPANSION_CACHE_BYTES = 64 * 1024 * 1024

export interface TranscriptDetailRef {
  entryId: string
  bytes: number
  omitted: true
  preview?: string
}

export interface TranscriptProjectOptions {
  wireBudget?: number
  bodyBudget?: number
  reservedTailBudget?: number
}

export type TranscriptDetailKind = 'message' | 'tool' | 'liveAssistant'

export interface TranscriptDetail {
  kind: TranscriptDetailKind
  entryId: string
  offset: number
  complete: boolean
  totalBytes: number
  encoding: 'json'
  chunk: string
  bytes: number
  sessionFile?: string
  revision?: number
  requestId?: string
  message?: PiMessage
  tool?: ToolRun
  assistant?: LiveAssistant
}

export type TranscriptDetailSource =
  | { kind: 'message'; entryId: string; message: PiMessage }
  | { kind: 'tool'; entryId: string; tool: ToolRun }
  | { kind: 'liveAssistant'; entryId: string; assistant: LiveAssistant }

export interface TranscriptDetailPageOptions {
  offset?: number
  limit?: number
  sessionFile?: string
  requestId?: string
}

const projectedMessages = new WeakMap<readonly PiMessage[], Map<string, PiMessage[]>>()
const encoder = new TextEncoder()

export function isTranscriptDetailRef(value: unknown): value is TranscriptDetailRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as { entryId?: unknown; bytes?: unknown; omitted?: unknown }
  return typeof ref.entryId === 'string' && typeof ref.bytes === 'number' && ref.omitted === true
}

export function isOmittedTranscriptMessage(message: PiMessage): boolean {
  return isTranscriptDetailRef(message.detailRef) || message.truncated === true
}

export function liveBlockEntryId(assistantId: string, blockIndex: number): string {
  return assistantId + '#' + String(blockIndex)
}

export function sameSessionFile(left?: string, right?: string): boolean {
  if (!left || !right) return false
  if (left === right) return true
  const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '')
  return normalize(left) === normalize(right)
}

export function messageMatchesTranscriptEntry(message: PiMessage, entryId: string): boolean {
  return message.workbenchEntryId === entryId || message.toolCallId === entryId
}

export function canonicalTranscriptEntryId(message: PiMessage, fallback: string): string {
  if (typeof message.workbenchEntryId === 'string' && message.workbenchEntryId && !message.workbenchEntryId.startsWith('anon:')) {
    return message.workbenchEntryId
  }
  if (typeof message.toolCallId === 'string' && message.toolCallId) return message.toolCallId
  return fallback
}

export function clampTranscriptDetailLimit(limit: number | undefined): number {
  const requested = limit == null ? TRANSCRIPT_DETAIL_PAGE_BYTES : Math.floor(limit)
  if (!Number.isFinite(requested)) return TRANSCRIPT_DETAIL_PAGE_BYTES
  return Math.min(TRANSCRIPT_DETAIL_PAGE_BYTES, Math.max(1, requested))
}

export function estimateJsonBytes(value: unknown): number {
  if (typeof value === 'string') return estimateJsonStringBytes(value)
  if (typeof value === 'number') return Number.isFinite(value) ? String(value).length : 8
  if (typeof value === 'boolean') return value ? 4 : 5
  if (value === null) return 4
  if (value === undefined) return 0
  if (Array.isArray(value)) {
    let total = 2
    for (let index = 0; index < value.length; index += 1) {
      total += estimateJsonBytes(value[index])
      if (index + 1 < value.length) total += 1
    }
    return total
  }
  if (typeof value === 'object') {
    let total = 2
    let first = true
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === undefined) continue
      if (!first) total += 1
      first = false
      total += estimateJsonStringBytes(key) + 1 + estimateJsonBytes(entry)
    }
    return total
  }
  return 8
}

export function estimateMessageBytes(message: PiMessage): number {
  return estimateJsonBytes(message)
}

export function projectTranscriptMessages(
  messages: readonly PiMessage[],
  options: TranscriptProjectOptions = {},
): PiMessage[] {
  if (messages.length === 0) return messages as PiMessage[]
  const key = optionsKey(options)
  const cachedForMessages = projectedMessages.get(messages)
  const cached = cachedForMessages?.get(key)
  if (cached) return cached
  const wireBudget = options.wireBudget ?? TRANSCRIPT_WIRE_BUDGET_BYTES
  const bodyBudget = options.bodyBudget ?? TRANSCRIPT_BODY_BUDGET_BYTES
  const reservedBudget = options.reservedTailBudget ?? TRANSCRIPT_RESERVED_TAIL_BYTES
  const reserved = reservedIndexes(messages)
  const projected = messages.map((message, index) => {
    const cap = reserved.has(index) ? reservedBudget : bodyBudget
    if (estimateMessageBytes(message) <= cap && !hasOmittedImageNeed(message)) return message
    return stubMessage(message, cap, index)
  })
  shrinkProjected(messages, projected, reserved, wireBudget)
  const next = projected.every((message, index) => message === messages[index]) ? messages as PiMessage[] : projected
  const bucket = cachedForMessages ?? new Map<string, PiMessage[]>()
  bucket.set(key, next)
  projectedMessages.set(messages, bucket)
  return next
}

export function projectWorkbenchSnapshot(
  snapshot: WorkbenchSnapshot,
  options: TranscriptProjectOptions = {},
): WorkbenchSnapshot {
  const wireBudget = options.wireBudget ?? TRANSCRIPT_WIRE_BUDGET_BYTES
  const messages = projectTranscriptMessages(snapshot.messages, options)
  let liveAssistant = projectLiveAssistant(snapshot.liveAssistant, options)
  let liveTools = projectLiveTools(snapshot.liveTools, options)
  const messageBytes = messages.reduce((sum, message) => sum + estimateMessageBytes(message), 0)
  const shrunk = shrinkLiveToBudget(liveAssistant, liveTools, Math.max(0, wireBudget - messageBytes))
  liveAssistant = shrunk.liveAssistant
  liveTools = shrunk.liveTools
  if (messages === snapshot.messages && liveAssistant === snapshot.liveAssistant && liveTools === snapshot.liveTools) {
    return snapshot
  }
  return { ...snapshot, messages, liveAssistant, liveTools }
}

export function findTranscriptDetail(
  sources: {
    messages?: readonly PiMessage[] | undefined
    liveTools?: readonly ToolRun[] | undefined
    liveAssistant?: LiveAssistant | undefined
  },
  entryId: string,
): TranscriptDetailSource | undefined {
  if (!entryId || entryId.startsWith('anon:')) return undefined
  for (const message of sources.messages ?? []) {
    if (!messageMatchesTranscriptEntry(message, entryId)) continue
    if (isOmittedTranscriptMessage(message)) continue
    return { kind: 'message', entryId: canonicalTranscriptEntryId(message, entryId), message }
  }
  for (const tool of sources.liveTools ?? []) {
    if (tool.id !== entryId && !(isTranscriptDetailRef(tool.detailRef) && tool.detailRef.entryId === entryId)) continue
    if (isTranscriptDetailRef(tool.detailRef)) continue
    return { kind: 'tool', entryId: tool.id, tool }
  }
  const assistant = sources.liveAssistant
  if (!assistant) return undefined
  if (assistant.id === entryId) return { kind: 'liveAssistant', entryId: assistant.id, assistant: assistantWithoutRefs(assistant) }
  for (const block of assistant.blocks) {
    const blockId = liveBlockEntryId(assistant.id, block.index)
    if (blockId === entryId || (isTranscriptDetailRef(block.detailRef) && block.detailRef.entryId === entryId)) {
      return { kind: 'liveAssistant', entryId: assistant.id, assistant: assistantWithoutRefs(assistant) }
    }
  }
  return undefined
}

export function findOmittedTranscriptEntry(
  sources: {
    messages?: readonly PiMessage[] | undefined
    liveTools?: readonly ToolRun[] | undefined
    liveAssistant?: LiveAssistant | undefined
  },
  entryId: string,
): { kind: TranscriptDetailKind; entryId: string; toolCallId?: string } | undefined {
  if (!entryId || entryId.startsWith('anon:')) return undefined
  for (const message of sources.messages ?? []) {
    if (!messageMatchesTranscriptEntry(message, entryId) && !(isTranscriptDetailRef(message.detailRef) && message.detailRef.entryId === entryId)) continue
    if (!isOmittedTranscriptMessage(message)) continue
    return {
      kind: 'message',
      entryId: canonicalTranscriptEntryId(message, entryId),
      ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    }
  }
  for (const tool of sources.liveTools ?? []) {
    if (tool.id !== entryId && !(isTranscriptDetailRef(tool.detailRef) && tool.detailRef.entryId === entryId)) continue
    if (!isTranscriptDetailRef(tool.detailRef)) continue
    return { kind: 'tool', entryId: tool.id }
  }
  const assistant = sources.liveAssistant
  if (!assistant) return undefined
  if (assistant.id === entryId) {
    if (assistant.blocks.some((block) => isTranscriptDetailRef(block.detailRef))) return { kind: 'liveAssistant', entryId: assistant.id }
  }
  for (const block of assistant.blocks) {
    const blockId = liveBlockEntryId(assistant.id, block.index)
    if (blockId !== entryId && !(isTranscriptDetailRef(block.detailRef) && block.detailRef.entryId === entryId)) continue
    if (!isTranscriptDetailRef(block.detailRef)) continue
    return { kind: 'liveAssistant', entryId: assistant.id }
  }
  return undefined
}

export function mergeTranscriptDetail(snapshot: WorkbenchSnapshot, detail: TranscriptDetail, cache?: TranscriptExpansionCache): WorkbenchSnapshot {
  if (detail.sessionFile && snapshot.session?.sessionFile && !sameSessionFile(detail.sessionFile, snapshot.session.sessionFile)) return snapshot
  const assembled = (cache ?? standaloneAssembler()).ingest(detail, snapshot.session?.sessionFile)
  if (!assembled) return snapshot
  return overlayExpandedTranscript(applyAssembledDetail(snapshot, assembled), cache)
}

export function pageTranscriptDetail(
  source: TranscriptDetailSource,
  options: TranscriptDetailPageOptions = {},
): TranscriptDetail {
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const limit = clampTranscriptDetailLimit(options.limit)
  const original = source.kind === 'message' ? source.message : source.kind === 'tool' ? source.tool : source.assistant
  const json = serializeAuthoritative(original)
  const encoded = encoder.encode(json)
  const totalBytes = encoded.length
  const slice = sliceUtf8Progress(encoded, offset, limit)
  const complete = offset >= totalBytes || offset + slice.bytes >= totalBytes
  const fitsWhole = offset === 0 && complete && totalBytes <= limit
  const page: TranscriptDetail = {
    kind: source.kind,
    entryId: source.entryId,
    offset,
    complete,
    totalBytes,
    encoding: 'json',
    chunk: slice.text,
    bytes: slice.bytes,
    revision: totalBytes,
    ...(options.sessionFile ? { sessionFile: options.sessionFile } : {}),
    ...(options.requestId ? { requestId: options.requestId } : {}),
  }
  if (fitsWhole && source.kind === 'message') page.message = source.message
  if (fitsWhole && source.kind === 'tool') page.tool = source.tool
  if (fitsWhole && source.kind === 'liveAssistant') page.assistant = source.assistant
  return page
}

export function projectLiveAssistant(assistant: LiveAssistant | undefined, options: TranscriptProjectOptions = {}): LiveAssistant | undefined {
  if (!assistant) return assistant
  const cap = options.reservedTailBudget ?? TRANSCRIPT_RESERVED_TAIL_BYTES
  const blocks = assistant.blocks.length > TRANSCRIPT_MAX_LIVE_BLOCKS
    ? assistant.blocks.slice(-TRANSCRIPT_MAX_LIVE_BLOCKS)
    : assistant.blocks
  let changed = blocks !== assistant.blocks
  const nextBlocks = blocks.map((block) => {
    const fullBytes = utf8ByteLength(block.text)
    if (fullBytes <= cap && !block.detailRef && !block.textOffset) return block
    changed = true
    if (fullBytes <= cap) {
      const clean: LiveBlock = { index: block.index, kind: block.kind, text: block.text }
      return clean
    }
    const window = tailUtf8(block.text, cap)
    return {
      index: block.index,
      kind: block.kind,
      text: window.text,
      textOffset: window.offset,
      detailRef: {
        entryId: liveBlockEntryId(assistant.id, block.index),
        bytes: fullBytes,
        omitted: true,
        preview: truncateString(block.text, TRANSCRIPT_PREVIEW_CHARS),
      } satisfies TranscriptDetailRef,
    }
  })
  return changed ? { id: assistant.id, blocks: nextBlocks } : assistant
}

export function projectLiveTools(tools: readonly ToolRun[] | undefined, options: TranscriptProjectOptions = {}): ToolRun[] {
  if (!tools || tools.length === 0) return (tools ?? []) as ToolRun[]
  const cap = options.bodyBudget ?? TRANSCRIPT_BODY_BUDGET_BYTES
  const selected = tools.length > TRANSCRIPT_MAX_LIVE_TOOLS ? tools.slice(-TRANSCRIPT_MAX_LIVE_TOOLS) : tools
  let changed = selected !== tools
  const next = selected.map((tool) => {
    const originalBytes = estimateJsonBytes(toolWithoutRef(tool))
    const argsOver = estimateJsonBytes(tool.args) > cap
    const detailsOver = estimateJsonBytes(tool.details) > cap
    const argsTextOver = typeof tool.argsText === 'string' && estimateJsonStringBytes(tool.argsText) > cap
    const outputBytes = typeof tool.output === 'string' ? utf8ByteLength(tool.output) : 0
    const outputOver = outputBytes > cap
    if (!argsOver && !detailsOver && !argsTextOver && !outputOver && selected === tools && !tool.detailRef && !tool.outputOffset) return tool
    if (!argsOver && !detailsOver && !argsTextOver && !outputOver && !tool.detailRef && !tool.outputOffset) return tool
    changed = true
    if (!argsOver && !detailsOver && !argsTextOver && !outputOver) return toolWithoutRef(tool)
    const outputWindow = outputOver && typeof tool.output === 'string' ? tailUtf8(tool.output, cap) : undefined
    const preview = outputWindow?.text
      ?? (typeof tool.output === 'string' && tool.output ? truncateString(tool.output, TRANSCRIPT_PREVIEW_CHARS) : undefined)
      ?? (typeof tool.argsText === 'string' ? truncateString(tool.argsText, TRANSCRIPT_PREVIEW_CHARS) : undefined)
    return {
      id: tool.id,
      name: tool.name,
      status: tool.status,
      isError: tool.isError,
      ...(argsOver ? {} : (tool.args !== undefined ? { args: tool.args } : {})),
      ...(detailsOver ? {} : (tool.details !== undefined ? { details: tool.details } : {})),
      ...(argsTextOver
        ? { argsText: truncateString(tool.argsText ?? '', TRANSCRIPT_PREVIEW_CHARS) }
        : (tool.argsText !== undefined ? { argsText: tool.argsText } : {})),
      ...(outputWindow
        ? { output: outputWindow.text, outputOffset: outputWindow.offset }
        : (tool.output !== undefined ? { output: tool.output } : {})),
      detailRef: {
        entryId: tool.id,
        bytes: originalBytes,
        omitted: true,
        ...(preview ? { preview: truncateString(preview, TRANSCRIPT_PREVIEW_CHARS) } : {}),
      } satisfies TranscriptDetailRef,
    }
  })
  return changed ? next : tools as ToolRun[]
}

export function overlayExpandedTranscript(snapshot: WorkbenchSnapshot, cache?: TranscriptExpansionCache): WorkbenchSnapshot {
  return cache ? cache.overlay(snapshot) : snapshot
}

export class TranscriptExpansionCache {
  readonly #entries = new Map<string, ExpansionEntry>()
  readonly #partials = new Map<string, DetailAssemblerState>()
  #bytes = 0

  ingest(detail: TranscriptDetail, sessionFile?: string): AssembledDetail | undefined {
    const session = detail.sessionFile ?? sessionFile ?? ''
    const assembler = this.#assembler(session, detail)
    if (!assembler) return undefined
    const assembled = assembler.push(detail)
    if (!assembled) return undefined
    this.#partials.delete(assemblerKey(session, detail.entryId, detail.revision))
    this.#remember(session, assembled)
    return assembled
  }

  overlay(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
    const session = snapshot.session?.sessionFile ?? ''
    let messagesChanged = false
    const messages = (snapshot.messages ?? []).map((message) => {
      const id = typeof message.workbenchEntryId === 'string' ? message.workbenchEntryId : undefined
      const expanded = (id ? this.#entries.get(entryKey(session, id)) : undefined)
        ?? (typeof message.toolCallId === 'string' ? this.#entries.get(entryKey(session, message.toolCallId)) : undefined)
      if (!expanded?.message) return message
      const cacheId = id ?? (typeof message.toolCallId === 'string' ? message.toolCallId : undefined)
      if (!isOmittedTranscriptMessage(message)) {
        if (cacheId && expanded.revision !== estimateMessageBytes(message)) this.#forget(session, cacheId)
        return message
      }
      const ref = message.detailRef
      if (isTranscriptDetailRef(ref) && ref.bytes !== expanded.revision) {
        if (cacheId) this.#forget(session, cacheId)
        return message
      }
      messagesChanged = true
      return expanded.message
    })
    let toolsChanged = false
    const liveTools = (snapshot.liveTools ?? []).map((tool) => {
      const expanded = this.#entries.get(entryKey(session, tool.id))
      if (!expanded?.tool) return tool
      if (!isTranscriptDetailRef(tool.detailRef)) {
        if (expanded.revision !== estimateJsonBytes(toolWithoutRef(tool))) this.#forget(session, tool.id)
        return tool
      }
      if (tool.detailRef.bytes !== expanded.revision) {
        this.#forget(session, tool.id)
        return tool
      }
      toolsChanged = true
      return expanded.tool
    })
    let assistant = snapshot.liveAssistant
    if (assistant) {
      const expanded = this.#entries.get(entryKey(session, assistant.id))
      if (expanded?.assistant && expanded.assistant.id === assistant.id) {
        assistant = mergeLiveAssistantOverlay(expanded.assistant, assistant)
        this.#remember(session, { kind: 'liveAssistant', entryId: assistant.id, revision: expanded.revision, assistant })
      }
    }
    if (!messagesChanged && !toolsChanged && assistant === snapshot.liveAssistant) return snapshot
    return {
      ...snapshot,
      ...(messagesChanged ? { messages } : {}),
      ...(toolsChanged ? { liveTools } : {}),
      ...(assistant !== snapshot.liveAssistant ? { liveAssistant: assistant } : {}),
    }
  }

  noteLiveOps(snapshot: WorkbenchSnapshot, ops: readonly LiveContentOp[]): void {
    const session = snapshot.session?.sessionFile ?? ''
    for (const op of ops) {
      if (op.op === 'trim') continue
      if (op.op === 'append' && op.target === 'assistant') {
        const key = entryKey(session, op.id)
        const current = this.#entries.get(key)?.assistant
        if (!current || current.id !== op.id) continue
        const blocks = current.blocks.map((block) => (
          block.index === op.blockIndex ? { ...block, text: block.text + op.text } : block
        ))
        this.#remember(session, { kind: 'liveAssistant', entryId: op.id, revision: this.#entries.get(key)?.revision ?? 0, assistant: { ...current, blocks } })
      }
      if (op.op === 'append' && op.target === 'tool') {
        const key = entryKey(session, op.id)
        const current = this.#entries.get(key)?.tool
        if (!current) continue
        this.#remember(session, {
          kind: 'tool',
          entryId: op.id,
          revision: this.#entries.get(key)?.revision ?? 0,
          tool: { ...current, output: (current.output ?? '') + op.text },
        })
      }
    }
  }

  switchSession(): void {
    this.#partials.clear()
  }

  #assembler(session: string, detail: TranscriptDetail): DetailAssemblerState | undefined {
    const key = assemblerKey(session, detail.entryId, detail.revision)
    const existing = this.#partials.get(key)
    if (existing) {
      if (detail.sessionFile && existing.sessionFile && !sameSessionFile(detail.sessionFile, existing.sessionFile)) return undefined
      if (detail.requestId && existing.requestId && detail.requestId !== existing.requestId && detail.offset === 0) {
        const fresh = createAssembler(detail, session)
        this.#partials.set(key, fresh)
        return fresh
      }
      return existing
    }
    const created = createAssembler(detail, session)
    this.#partials.set(key, created)
    return created
  }

  #remember(session: string, assembled: AssembledDetail): void {
    const key = entryKey(session, assembled.entryId)
    const previous = this.#entries.get(key)
    if (previous) this.#bytes -= previous.bytes
    const bytes = assembledBytes(assembled)
    this.#entries.delete(key)
    this.#entries.set(key, { ...assembled, bytes })
    this.#bytes += bytes
    while (this.#entries.size > TRANSCRIPT_EXPANSION_CACHE_MAX || this.#bytes > TRANSCRIPT_EXPANSION_CACHE_BYTES) {
      const oldest = this.#entries.keys().next().value
      if (!oldest || oldest === key) break
      const dropped = this.#entries.get(oldest)
      this.#entries.delete(oldest)
      if (dropped) this.#bytes -= dropped.bytes
    }
  }

  #forget(session: string, entryId: string): void {
    const key = entryKey(session, entryId)
    const dropped = this.#entries.get(key)
    if (!dropped) return
    this.#entries.delete(key)
    this.#bytes -= dropped.bytes
  }
}

function optionsKey(options: TranscriptProjectOptions): string {
  return [
    options.wireBudget ?? 'd',
    options.bodyBudget ?? 'd',
    options.reservedTailBudget ?? 'd',
  ].join(':')
}

function reservedIndexes(messages: readonly PiMessage[]): Set<number> {
  const reserved = new Set<number>()
  let lastUser = -1
  let lastAssistant = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const role = messages[index]?.role
    if (lastUser < 0 && role === 'user') lastUser = index
    if (lastAssistant < 0 && role === 'assistant') lastAssistant = index
    if (lastUser >= 0 && lastAssistant >= 0) break
  }
  if (lastUser >= 0) reserved.add(lastUser)
  if (lastAssistant >= 0) reserved.add(lastAssistant)
  return reserved
}

function hasOmittedImageNeed(message: PiMessage): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => block.type === 'image' && typeof block.data === 'string' && utf8ByteLength(block.data) > TRANSCRIPT_BODY_BUDGET_BYTES)
}

function shrinkProjected(
  originals: readonly PiMessage[],
  projected: PiMessage[],
  reserved: Set<number>,
  wireBudget: number,
): void {
  let total = projected.reduce((sum, message) => sum + estimateMessageBytes(message), 0)
  if (total <= wireBudget) return
  for (let index = 0; index < projected.length && total > wireBudget; index += 1) {
    if (reserved.has(index)) continue
    const before = estimateMessageBytes(projected[index]!)
    const stub = stubMessage(originals[index]!, 0, index)
    projected[index] = stub
    total += estimateMessageBytes(stub) - before
  }
  if (total <= wireBudget) return
  for (const index of reserved) {
    if (total <= wireBudget) break
    const before = estimateMessageBytes(projected[index]!)
    const stub = stubMessage(originals[index]!, TRANSCRIPT_PREVIEW_CHARS, index)
    projected[index] = stub
    total += estimateMessageBytes(stub) - before
  }
  if (total <= wireBudget) return
  for (let index = 0; index < projected.length && total > wireBudget; index += 1) {
    const before = estimateMessageBytes(projected[index]!)
    const stub = minimalStub(originals[index]!, index)
    projected[index] = stub
    total += estimateMessageBytes(stub) - before
  }
}

function shrinkLiveToBudget(
  liveAssistant: LiveAssistant | undefined,
  liveTools: readonly ToolRun[] | undefined,
  remaining: number,
): { liveAssistant: LiveAssistant | undefined; liveTools: ToolRun[] } {
  let tools = (liveTools ?? []) as ToolRun[]
  let assistant = liveAssistant
  let total = estimateJsonBytes(assistant) + estimateJsonBytes(tools)
  if (total <= remaining) return { liveAssistant: assistant, liveTools: tools }
  if (tools.length) {
    const next = tools.map((tool) => minimalToolStub(tool))
    total += estimateJsonBytes(next) - estimateJsonBytes(tools)
    tools = next
  }
  if (total <= remaining) return { liveAssistant: assistant, liveTools: tools }
  if (assistant) {
    const nextBlocks = assistant.blocks.map((block) => {
      if (utf8ByteLength(block.text) <= TRANSCRIPT_PREVIEW_CHARS) return block
      const window = tailUtf8(block.text, TRANSCRIPT_PREVIEW_CHARS)
      return {
        index: block.index,
        kind: block.kind,
        text: window.text,
        textOffset: (block.textOffset ?? 0) + window.offset,
        detailRef: block.detailRef ?? {
          entryId: liveBlockEntryId(assistant!.id, block.index),
          bytes: utf8ByteLength(block.text) + (block.textOffset ?? 0),
          omitted: true as const,
        },
      }
    })
    assistant = { ...assistant, blocks: nextBlocks }
  }
  return { liveAssistant: assistant, liveTools: tools }
}

function stubMessage(message: PiMessage, keepBytes: number, index: number): PiMessage {
  const entryId = stableEntryId(message, index)
  const bytes = estimateMessageBytes(message)
  const preview = previewText(message, TRANSCRIPT_PREVIEW_CHARS)
  const stub: PiMessage = {
    role: message.role,
    workbenchEntryId: entryId,
    detailRef: { entryId, bytes, omitted: true, ...(preview ? { preview } : {}) } satisfies TranscriptDetailRef,
  }
  if (typeof message.timestamp === 'number') stub.timestamp = message.timestamp
  if (typeof message.toolCallId === 'string') stub.toolCallId = message.toolCallId
  if (typeof message.toolName === 'string') stub.toolName = truncateString(message.toolName, TRANSCRIPT_STUB_META_CHARS)
  if (typeof message.isError === 'boolean') stub.isError = message.isError
  if (typeof message.display === 'boolean') stub.display = message.display
  if (keepBytes > 0) {
    const content = truncateContent(message.content, keepBytes)
    if (content !== undefined) stub.content = content
    if (typeof message.output === 'string') stub.output = truncateString(message.output, Math.min(keepBytes, TRANSCRIPT_PREVIEW_CHARS))
  }
  return stub
}

function minimalStub(message: PiMessage, index: number): PiMessage {
  const entryId = stableEntryId(message, index)
  return {
    role: message.role,
    workbenchEntryId: entryId,
    detailRef: {
      entryId,
      bytes: estimateMessageBytes(message),
      omitted: true,
    } satisfies TranscriptDetailRef,
  }
}

function minimalToolStub(tool: ToolRun): ToolRun {
  const bytes = isTranscriptDetailRef(tool.detailRef) ? tool.detailRef.bytes : estimateJsonBytes(toolWithoutRef(tool))
  return {
    id: tool.id,
    name: tool.name,
    status: tool.status,
    isError: tool.isError,
    detailRef: {
      entryId: tool.id,
      bytes,
      omitted: true,
      ...(typeof tool.output === 'string' && tool.output ? { preview: truncateString(tool.output, TRANSCRIPT_PREVIEW_CHARS) } : {}),
    },
  }
}

function stableEntryId(message: PiMessage, index: number): string {
  if (typeof message.workbenchEntryId === 'string' && message.workbenchEntryId && !message.workbenchEntryId.startsWith('anon:')) {
    return message.workbenchEntryId
  }
  return 'anon:' + String(index) + ':' + message.role + ':' + String(message.timestamp ?? 0)
}

function previewText(message: PiMessage, limit: number): string {
  if (typeof message.content === 'string' && message.content) return truncateString(message.content, limit)
  if (typeof message.output === 'string' && message.output) return truncateString(message.output, limit)
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block.text === 'string' && block.text) return truncateString(block.text, limit)
      if (typeof block.thinking === 'string' && block.thinking) return truncateString(block.thinking, limit)
    }
  }
  return ''
}

function truncateContent(content: PiMessage['content'], keepBytes: number): PiMessage['content'] {
  if (typeof content === 'string') return truncateString(content, Math.min(keepBytes, TRANSCRIPT_PREVIEW_CHARS))
  if (!Array.isArray(content)) return undefined
  const kept = content.slice(0, TRANSCRIPT_MAX_STUB_BLOCKS).map((block) => stubBlock(block, keepBytes))
  return kept
}

function stubBlock(block: PiContentBlock, keepBytes: number): PiContentBlock {
  const type = typeof block.type === 'string' ? block.type : 'text'
  if (type === 'image') {
    const bytes = typeof block.data === 'string' ? utf8ByteLength(block.data) : 0
    return { type: 'image', omitted: true, bytes, ...(typeof block.mimeType === 'string' ? { mimeType: block.mimeType } : {}) }
  }
  const stub: PiContentBlock = { type }
  if (typeof block.id === 'string') stub.id = block.id
  if (typeof block.name === 'string') stub.name = truncateString(block.name, TRANSCRIPT_STUB_META_CHARS)
  if (typeof block.text === 'string' && keepBytes > 0) stub.text = truncateString(block.text, Math.min(keepBytes, TRANSCRIPT_PREVIEW_CHARS))
  if (typeof block.thinking === 'string' && keepBytes > 0) stub.thinking = truncateString(block.thinking, Math.min(keepBytes, TRANSCRIPT_PREVIEW_CHARS))
  return stub
}

function truncateString(text: string, keepChars: number): string {
  if (text.length <= keepChars) return text
  return text.slice(0, Math.max(0, keepChars)) + '…'
}

function serializeAuthoritative(value: unknown): string {
  return JSON.stringify(value) ?? '{}'
}

function toolWithoutRef(tool: ToolRun): ToolRun {
  if (!tool.detailRef) return tool
  const next = { ...tool }
  delete next.detailRef
  return next
}

function assistantWithoutRefs(assistant: LiveAssistant): LiveAssistant {
  return {
    id: assistant.id,
    blocks: assistant.blocks.map((block) => {
      const next: LiveBlock = { index: block.index, kind: block.kind, text: block.text }
      return next
    }),
  }
}

function applyAssembledDetail(snapshot: WorkbenchSnapshot, assembled: AssembledDetail): WorkbenchSnapshot {
  if (assembled.kind === 'message' && assembled.message) {
    let found = false
    const messages = snapshot.messages.map((message) => {
      if (!messageMatchesAssembledMessage(message, assembled)) return message
      found = true
      const { detailRef: _ignored, ...rest } = assembled.message!
      return { ...rest, workbenchEntryId: message.workbenchEntryId ?? assembled.entryId }
    })
    return found ? { ...snapshot, messages } : snapshot
  }
  if (assembled.kind === 'tool' && assembled.tool) {
    let toolsFound = false
    const liveTools = snapshot.liveTools.map((tool) => {
      if (tool.id !== assembled.entryId) return tool
      toolsFound = true
      const next = { ...assembled.tool! }
      delete next.detailRef
      return next
    })
    let messagesFound = false
    const messages = snapshot.messages.map((message) => {
      if (message.toolCallId !== assembled.entryId && message.workbenchEntryId !== assembled.entryId) return message
      if (!isOmittedTranscriptMessage(message)) return message
      messagesFound = true
      const output = assembled.tool!.output
      const { detailRef: _ignored, ...rest } = message
      return {
        ...rest,
        ...(typeof output === 'string' ? { content: output, output } : {}),
      }
    })
    if (!toolsFound && !messagesFound) return snapshot
    return {
      ...snapshot,
      ...(toolsFound ? { liveTools } : {}),
      ...(messagesFound ? { messages } : {}),
    }
  }
  if (assembled.kind === 'liveAssistant' && assembled.assistant) {
    return { ...snapshot, liveAssistant: assembled.assistant }
  }
  return snapshot
}

function messageMatchesAssembledMessage(message: PiMessage, assembled: AssembledDetail): boolean {
  if (messageMatchesTranscriptEntry(message, assembled.entryId)) return true
  const restored = assembled.message?.workbenchEntryId
  return typeof restored === 'string' && restored.length > 0 && message.workbenchEntryId === restored
}

function mergeLiveAssistantOverlay(cached: LiveAssistant, incoming: LiveAssistant): LiveAssistant {
  if (cached.id !== incoming.id) return incoming
  const incomingByIndex = new Map(incoming.blocks.map((block) => [block.index, block]))
  const blocks = cached.blocks.map((block) => {
    const next = incomingByIndex.get(block.index)
    if (!next) return block
    if (!next.detailRef && (next.textOffset ?? 0) === 0 && next.text.startsWith(block.text)) return next
    const offset = next.textOffset ?? 0
    if (offset <= 0) {
      return next.text.length >= block.text.length ? next : block
    }
    const expectedTail = dropUtf8Prefix(block.text, offset)
    if (next.text.startsWith(expectedTail)) return { ...block, text: block.text + next.text.slice(expectedTail.length) }
    if (expectedTail.startsWith(next.text)) return block
    return { ...block, text: utf8Prefix(block.text, offset) + next.text }
  })
  const seen = new Set(blocks.map((block) => block.index))
  for (const block of incoming.blocks) {
    if (!seen.has(block.index)) blocks.push(block)
  }
  blocks.sort((left, right) => left.index - right.index)
  return { id: cached.id, blocks }
}

function utf8Prefix(text: string, keepBytes: number): string {
  if (keepBytes <= 0) return ''
  const encoded = encoder.encode(text)
  if (keepBytes >= encoded.length) return text
  const slice = sliceUtf8Progress(encoded, 0, keepBytes)
  return slice.text
}

interface AssembledDetail {
  kind: TranscriptDetailKind
  entryId: string
  revision: number
  message?: PiMessage
  tool?: ToolRun
  assistant?: LiveAssistant
}

interface ExpansionEntry extends AssembledDetail {
  bytes: number
}

interface DetailAssemblerState {
  kind: TranscriptDetailKind
  entryId: string
  sessionFile: string
  revision: number
  requestId?: string
  expectedOffset: number
  totalBytes: number
  chunks: string
  buffered: Map<number, { chunk: string; bytes: number }>
  push(detail: TranscriptDetail): AssembledDetail | undefined
}

function createAssembler(detail: TranscriptDetail, sessionFile: string): DetailAssemblerState {
  const state: DetailAssemblerState = {
    kind: detail.kind,
    entryId: detail.entryId,
    sessionFile: detail.sessionFile ?? sessionFile,
    revision: detail.revision ?? 0,
    ...(detail.requestId ? { requestId: detail.requestId } : {}),
    expectedOffset: 0,
    totalBytes: detail.totalBytes,
    chunks: '',
    buffered: new Map(),
    push(page: TranscriptDetail) {
      if (page.kind !== state.kind || page.entryId !== state.entryId) return undefined
      if (page.sessionFile && state.sessionFile && !sameSessionFile(page.sessionFile, state.sessionFile)) return undefined
      if (page.revision != null && state.revision && page.revision !== state.revision) return undefined
      if (page.offset < 0) return undefined
      if (page.complete && page.offset === 0 && (page.message || page.tool || page.assistant)) {
        return decodeAssembled(page, page.chunk || serializeAuthoritative(page.message ?? page.tool ?? page.assistant))
      }
      if (page.bytes === 0 && !page.complete && page.offset < page.totalBytes) {
        throw new Error('Transcript detail page made no progress')
      }
      if (page.offset !== state.expectedOffset) {
        if (page.offset < state.expectedOffset) return undefined
        state.buffered.set(page.offset, { chunk: page.chunk, bytes: page.bytes })
        return undefined
      }
      state.chunks += page.chunk
      state.expectedOffset += page.bytes
      while (state.buffered.has(state.expectedOffset)) {
        const next = state.buffered.get(state.expectedOffset)!
        state.buffered.delete(state.expectedOffset)
        state.chunks += next.chunk
        state.expectedOffset += next.bytes
      }
      if (!page.complete && state.expectedOffset < state.totalBytes) return undefined
      return decodeAssembled(page, state.chunks)
    },
  }
  return state
}

function decodeAssembled(page: TranscriptDetail, json: string): AssembledDetail {
  if (page.message && page.kind === 'message') return { kind: 'message', entryId: page.entryId, revision: page.revision ?? page.totalBytes, message: page.message }
  if (page.tool && page.kind === 'tool') return { kind: 'tool', entryId: page.entryId, revision: page.revision ?? page.totalBytes, tool: page.tool }
  if (page.assistant && page.kind === 'liveAssistant') {
    return { kind: 'liveAssistant', entryId: page.entryId, revision: page.revision ?? page.totalBytes, assistant: page.assistant }
  }
  const parsed = JSON.parse(json) as unknown
  if (page.kind === 'message') return { kind: 'message', entryId: page.entryId, revision: page.revision ?? page.totalBytes, message: parsed as PiMessage }
  if (page.kind === 'tool') return { kind: 'tool', entryId: page.entryId, revision: page.revision ?? page.totalBytes, tool: parsed as ToolRun }
  return { kind: 'liveAssistant', entryId: page.entryId, revision: page.revision ?? page.totalBytes, assistant: parsed as LiveAssistant }
}

function standaloneAssembler(): TranscriptExpansionCache {
  return new TranscriptExpansionCache()
}

function sessionIdentity(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '')
}

function entryKey(session: string, entryId: string): string {
  return sessionIdentity(session) + '\0' + entryId
}

function assemblerKey(session: string, entryId: string, revision: number | undefined): string {
  return sessionIdentity(session) + '\0' + entryId + '\0' + String(revision ?? 0)
}

function assembledBytes(assembled: AssembledDetail): number {
  if (assembled.message) return estimateMessageBytes(assembled.message)
  if (assembled.tool) return estimateJsonBytes(assembled.tool)
  if (assembled.assistant) return estimateJsonBytes(assembled.assistant)
  return 0
}

function estimateJsonStringBytes(text: string): number {
  let bytes = 2
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x22 || code === 0x5c) bytes += 2
    else if (code <= 0x1f) bytes += 6
    else if (code <= 0x7f) bytes += 1
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4
        index += 1
      } else bytes += 6
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6
    else if (code <= 0x7ff) bytes += 2
    else bytes += 3
  }
  return bytes
}
