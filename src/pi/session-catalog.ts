import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { basename, join, resolve } from 'node:path'
import { asRecord, contentText } from '../workbench/state.ts'

export interface PiSessionSummary {
  id: string
  path: string
  cwd: string
  title: string
  name?: string | undefined
  firstMessage: string
  messageCount: number
  createdAt: number
  modifiedAt: number
}

export interface SessionCatalogOptions {
  agentDir?: string
  limit?: number
  scope?: 'all' | 'cwd'
  concurrency?: number
}

interface SessionFileMeta {
  path: string
  mtimeMs: number
  birthtimeMs: number
  size: number
}

interface SessionCacheEntry {
  mtimeMs: number
  size: number
  summary: PiSessionSummary
}

interface HeaderAccumulator {
  id: string
  cwd: string
  name?: string | undefined
  firstMessage: string
  foundFirstUser: boolean
  messageCount: number
  createdAt: number
}

const READ_CHUNK_BYTES = 16 * 1024
const RENAME_TAIL_BYTES = 32 * 1024
const FULL_SCAN_BYTES = 128 * 1024
const DEFAULT_CONCURRENCY = 24
const SESSION_META_CONCURRENCY = 64

export class PiSessionCatalog {
  readonly #options: SessionCatalogOptions
  readonly #cache = new Map<string, SessionCacheEntry>()

  constructor(options: SessionCatalogOptions = {}) {
    this.#options = options
  }

  list(cwd: string, limit = this.#options.limit): Promise<PiSessionSummary[]> {
    const options = limit === undefined ? this.#options : { ...this.#options, limit }
    return listPiSessionsCached(cwd, options, this.#cache)
  }
}

export function listPiSessions(cwd: string, options: SessionCatalogOptions = {}): Promise<PiSessionSummary[]> {
  return listPiSessionsCached(cwd, options, new Map())
}

async function listPiSessionsCached(
  cwd: string,
  options: SessionCatalogOptions,
  cache: Map<string, SessionCacheEntry>,
): Promise<PiSessionSummary[]> {
  const paths = await listSessionPaths(cwd, options)
  const metas = (await mapConcurrent(paths, options.concurrency ?? SESSION_META_CONCURRENCY, sessionMeta))
    .filter((meta): meta is SessionFileMeta => meta !== null)
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  const selected = options.limit === undefined ? metas : metas.slice(0, Math.max(0, options.limit))
  const livePaths = new Set(metas.map((meta) => meta.path))
  for (const path of cache.keys()) if (!livePaths.has(path)) cache.delete(path)
  const sessions = (await mapConcurrent(selected, options.concurrency ?? DEFAULT_CONCURRENCY, (meta) => readPiSessionSummary(meta, cache)))
    .filter((session): session is PiSessionSummary => session !== null)
  return sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

async function listSessionPaths(cwd: string, options: SessionCatalogOptions): Promise<string[]> {
  if ((options.scope ?? 'all') === 'cwd') return jsonlFiles(getPiSessionDirectory(cwd, options.agentDir))
  const root = getPiSessionRoot(options.agentDir)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const directories = entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name))
  const nested = await mapConcurrent(directories, 12, jsonlFiles)
  return nested.flat()
}

async function jsonlFiles(directory: string): Promise<string[]> {
  try {
    const names = await readdir(directory)
    return names.filter((name) => name.endsWith('.jsonl')).map((name) => join(directory, name))
  } catch {
    return []
  }
}

async function sessionMeta(path: string): Promise<SessionFileMeta | null> {
  try {
    const fileStats = await stat(path)
    return {
      path,
      mtimeMs: fileStats.mtimeMs,
      birthtimeMs: fileStats.birthtimeMs,
      size: fileStats.size,
    }
  } catch {
    return null
  }
}

export function getPiSessionRoot(configuredAgentDir?: string): string {
  if (!configuredAgentDir && process.env.PI_CODING_AGENT_SESSION_DIR) return resolve(expandTilde(process.env.PI_CODING_AGENT_SESSION_DIR))
  const agentDir = resolve(expandTilde(configuredAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')))
  return join(agentDir, 'sessions')
}

export function getPiSessionDirectory(cwd: string, configuredAgentDir?: string): string {
  const resolvedCwd = resolve(cwd)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(getPiSessionRoot(configuredAgentDir), safePath)
}

async function readPiSessionSummary(
  meta: SessionFileMeta,
  cache: Map<string, SessionCacheEntry>,
): Promise<PiSessionSummary | null> {
  const cached = cache.get(meta.path)
  if (cached?.mtimeMs === meta.mtimeMs && cached.size === meta.size) return cached.summary
  const accumulator: HeaderAccumulator = {
    id: '',
    cwd: '',
    firstMessage: '',
    foundFirstUser: false,
    messageCount: 0,
    createdAt: meta.birthtimeMs || meta.mtimeMs,
  }
  const scanToEnd = meta.size <= FULL_SCAN_BYTES
  let reachedEnd = false
  let handle
  try {
    handle = await open(meta.path, 'r')
    const decoder = new StringDecoder('utf8')
    let pending = ''
    let position = 0
    while (position < meta.size) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, meta.size - position))
      const result = await handle.read(buffer, 0, buffer.length, position)
      if (result.bytesRead === 0) break
      position += result.bytesRead
      pending += decoder.write(buffer.subarray(0, result.bytesRead))
      let newline = pending.indexOf('\n')
      while (newline >= 0) {
        const line = pending.slice(0, newline).replace(/\r$/, '')
        pending = pending.slice(newline + 1)
        const foundFirstUser = consumeSessionLine(line, accumulator)
        if (foundFirstUser && !scanToEnd) break
        newline = pending.indexOf('\n')
      }
      if (accumulator.foundFirstUser && !scanToEnd) break
    }
    if (position >= meta.size) {
      pending += decoder.end()
      if (pending.trim()) consumeSessionLine(pending.replace(/\r$/, ''), accumulator)
      reachedEnd = true
    }
  } catch {
    return null
  } finally {
    await handle?.close().catch(() => undefined)
  }

  if (!accumulator.id) return null
  if (!reachedEnd) {
    const tailName = await latestSessionName(meta)
    if (tailName.found) accumulator.name = tailName.name
  }
  const fallback = accumulator.firstMessage || '(image or attachment)'
  const summary: PiSessionSummary = {
    id: accumulator.id,
    path: meta.path,
    cwd: accumulator.cwd,
    title: accumulator.name ?? compactTitle(fallback),
    ...(accumulator.name ? { name: accumulator.name } : {}),
    firstMessage: fallback,
    messageCount: accumulator.messageCount,
    createdAt: accumulator.createdAt,
    modifiedAt: meta.mtimeMs,
  }
  cache.set(meta.path, { mtimeMs: meta.mtimeMs, size: meta.size, summary })
  return summary
}

function consumeSessionLine(line: string, accumulator: HeaderAccumulator): boolean {
  if (!line.trim()) return false
  let entry: Record<string, unknown>
  try {
    entry = JSON.parse(line) as Record<string, unknown>
  } catch {
    return false
  }
  if (!accumulator.id) {
    if (entry.type !== 'session' || typeof entry.id !== 'string') return false
    accumulator.id = entry.id
    accumulator.cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
    accumulator.createdAt = timestampMs(entry.timestamp) ?? accumulator.createdAt
    return false
  }
  if (entry.type === 'session_info') {
    accumulator.name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
    return false
  }
  if (entry.type !== 'message') return false
  accumulator.messageCount++
  const message = asRecord(entry.message)
  if (message.role !== 'user' || accumulator.foundFirstUser) return false
  accumulator.foundFirstUser = true
  accumulator.firstMessage = contentText(message.content).trim()
  return true
}

async function latestSessionName(meta: SessionFileMeta): Promise<{ found: boolean; name?: string }> {
  if (meta.size <= 0) return { found: false }
  let handle
  try {
    handle = await open(meta.path, 'r')
    const size = Math.min(RENAME_TAIL_BYTES, meta.size)
    const offset = meta.size - size
    const buffer = Buffer.allocUnsafe(size)
    const result = await handle.read(buffer, 0, size, offset)
    let text = buffer.subarray(0, result.bytesRead).toString('utf8')
    if (offset > 0) {
      const newline = text.indexOf('\n')
      text = newline >= 0 ? text.slice(newline + 1) : ''
    }
    let found = false
    let name: string | undefined
    for (const line of text.split('\n')) {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.type !== 'session_info') continue
        found = true
        name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
      } catch {
        continue
      }
    }
    return { found, ...(name ? { name } : {}) }
  } catch {
    return { found: false }
  } finally {
    await handle?.close().catch(() => undefined)
  }
}

async function mapConcurrent<Input, Output>(
  values: Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(values.length, Math.max(1, concurrency)) }, async () => {
    while (true) {
      const index = cursor++
      if (index >= values.length) return
      output[index] = await mapper(values[index]!)
    }
  })
  await Promise.all(workers)
  return output
}

function timestampMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function compactTitle(value: string): string {
  const firstLine = value.split('\n', 1)[0]?.trim() || '(no messages)'
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine
}

function expandTilde(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

export function sessionProjectName(session: Pick<PiSessionSummary, 'cwd'>): string {
  return basename(session.cwd) || session.cwd || 'Unknown project'
}
