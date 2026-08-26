import { createReadStream } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'
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
}

interface SessionCacheEntry {
  mtimeMs: number
  size: number
  summary: PiSessionSummary
}

export class PiSessionCatalog {
  readonly #options: SessionCatalogOptions
  readonly #cache = new Map<string, SessionCacheEntry>()

  constructor(options: SessionCatalogOptions = {}) {
    this.#options = options
  }

  list(cwd: string): Promise<PiSessionSummary[]> {
    return listPiSessionsCached(cwd, this.#options, this.#cache)
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
  const directory = getPiSessionDirectory(cwd, options.agentDir)
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return []
  }
  const limit = options.limit ?? 80
  const paths = names
    .filter((name) => name.endsWith('.jsonl'))
    .sort((left, right) => right.localeCompare(left))
    .slice(0, limit)
    .map((name) => join(directory, name))
  const livePaths = new Set(paths)
  for (const path of cache.keys()) if (!livePaths.has(path)) cache.delete(path)
  const sessions = (await Promise.all(paths.map((path) => readPiSessionSummary(path, cache)))).filter(
    (session): session is PiSessionSummary => session !== null,
  )
  return sessions.sort((left, right) => right.modifiedAt - left.modifiedAt)
}

export function getPiSessionDirectory(cwd: string, configuredAgentDir?: string): string {
  const agentDir = resolve(expandTilde(configuredAgentDir ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')))
  const resolvedCwd = resolve(cwd)
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`
  return join(agentDir, 'sessions', safePath)
}

async function readPiSessionSummary(
  path: string,
  cache: Map<string, SessionCacheEntry>,
): Promise<PiSessionSummary | null> {
  try {
    const fileStats = await stat(path)
    const cached = cache.get(path)
    if (cached?.mtimeMs === fileStats.mtimeMs && cached.size === fileStats.size) return cached.summary
    const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
    let id = ''
    let cwd = ''
    let name: string | undefined
    let firstMessage = ''
    let messageCount = 0
    let createdAt = fileStats.birthtimeMs || fileStats.mtimeMs
    let modifiedAt = fileStats.mtimeMs

    for await (const line of lines) {
      if (!line.trim()) continue
      let entry: Record<string, unknown>
      try {
        entry = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      if (!id) {
        if (entry.type !== 'session' || typeof entry.id !== 'string') return null
        id = entry.id
        cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
        const timestamp = timestampMs(entry.timestamp)
        if (timestamp !== undefined) createdAt = timestamp
        continue
      }
      if (entry.type === 'session_info') {
        name = typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : undefined
        continue
      }
      if (entry.type !== 'message') continue
      messageCount++
      const message = asRecord(entry.message)
      const timestamp = typeof message.timestamp === 'number' ? message.timestamp : timestampMs(entry.timestamp)
      if (timestamp !== undefined) modifiedAt = Math.max(modifiedAt, timestamp)
      if (!firstMessage && message.role === 'user') firstMessage = contentText(message.content).trim()
    }

    if (!id) return null
    const fallback = firstMessage || '(no messages)'
    const summary: PiSessionSummary = {
      id,
      path,
      cwd,
      title: name ?? compactTitle(fallback),
      ...(name ? { name } : {}),
      firstMessage: fallback,
      messageCount,
      createdAt,
      modifiedAt,
    }
    cache.set(path, { mtimeMs: fileStats.mtimeMs, size: fileStats.size, summary })
    return summary
  } catch {
    return null
  }
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
