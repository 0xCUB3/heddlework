import type { ToolRun } from '../workbench/state.ts'
import { headlineArg } from './call-preview.ts'
import type { FabricAuditPresentation, ToolPresentation } from './tool-presenters.ts'

export const BALANCED_PREVIEW_MAX_LINES = 8
export const BALANCED_PREVIEW_MAX_CHARS = 2_400
export const DETAILED_PREVIEW_MAX_LINES = 48

function optField(key: string, value: unknown) {
  return value === undefined ? {} : { [key]: value }
}

export type ToolActivityPhase = 'preparing' | 'running' | 'complete' | 'failed'

export interface BoundedExcerpt {
  text: string
  lineCount: number
  totalLines: number
  hiddenLines: number
}

export interface FabricChildActivityPreview {
  ref: string
  title: string
  phase: ToolActivityPhase
  durationMs?: number
  path?: string
  rangeLabel?: string
  excerpt?: BoundedExcerpt
}

export interface ToolActivityPreview {
  phase: ToolActivityPhase
  title: string
  subtitle?: string
  statusLabel: string
  durationMs?: number
  path?: string
  rangeLabel?: string
  language?: string
  excerpt?: BoundedExcerpt
  outputTail?: BoundedExcerpt
  diffExcerpt?: BoundedExcerpt
  matchLines?: BoundedExcerpt
  matchTotal?: number
  preparingLabel?: string
  fabric?: {
    name: string
    description?: string
    codeExcerpt?: BoundedExcerpt
    children: FabricChildActivityPreview[]
    completed: number
    failed: number
    running: number
  }
}

export interface TranscriptVisibilityOptions {
  detailed: boolean
  maxPreviewLines?: number
}

export function mergeToolArgs(args: unknown, argsText: string | undefined): Record<string, unknown> {
  const merged = args !== null && typeof args === 'object' && !Array.isArray(args)
    ? { ...(args as Record<string, unknown>) }
    : {}
  if (!argsText?.trim()) return merged
  const partial = parsePartialToolArgs(argsText)
  for (const [key, value] of Object.entries(partial)) {
    if (merged[key] === undefined) merged[key] = value
  }
  return merged
}

export function parsePartialToolArgs(raw: string): Record<string, unknown> {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const parsed = JSON.parse(trimmed) as unknown
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    // fall through to tolerant field extraction
  }
  const out: Record<string, unknown> = {}
  const displayName = extractPartialJsonString(trimmed, 'display', 'name') ?? extractPartialJsonString(trimmed, 'name')
  const displayDescription = extractPartialJsonString(trimmed, 'display', 'description') ?? extractPartialJsonString(trimmed, 'description')
  if (displayName || displayDescription) {
    out.display = {
      ...(displayName ? { name: displayName } : {}),
      ...(displayDescription ? { description: displayDescription } : {}),
    }
  }
  const code = extractPartialJsonString(trimmed, 'code')
  if (code) out.code = code
  for (const key of ['path', 'command', 'pattern', 'query'] as const) {
    const value = extractPartialJsonString(trimmed, key)
    if (value) out[key] = value
  }
  return out
}

export function boundedExcerpt(value: string, maxLines = BALANCED_PREVIEW_MAX_LINES, maxChars = BALANCED_PREVIEW_MAX_CHARS): BoundedExcerpt | undefined {
  const normalized = value.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (!normalized.trim()) return undefined
  const lines = normalized.split('\n')
  const totalLines = lines.length
  let selected = lines.slice(0, maxLines)
  let text = selected.join('\n')
  if (text.length > maxChars) {
    text = text.slice(0, maxChars)
    selected = text.split('\n')
  }
  const lineCount = selected.length
  const hiddenLines = Math.max(0, totalLines - lineCount)
  return { text, lineCount, totalLines, hiddenLines }
}

export function hiddenLinesLabel(hiddenLines: number): string {
  if (hiddenLines <= 0) return ''
  return hiddenLines === 1 ? '1 line hidden' : `${hiddenLines} lines hidden`
}

export function toolActivityPhase(tool: ToolRun): ToolActivityPhase {
  if (tool.isError) return 'failed'
  if (tool.status === 'preparing') return 'preparing'
  if (tool.status === 'running') return 'running'
  return 'complete'
}

export function toolStatusLabel(tool: ToolRun): string {
  const phase = toolActivityPhase(tool)
  if (phase === 'failed') return 'failed'
  if (phase === 'preparing') return 'preparing'
  if (phase === 'running') return 'running'
  return 'done'
}

export function toolDurationMs(tool: ToolRun, presentation: ToolPresentation): number | undefined {
  const details = presentation.fabric ? undefined : findNumberProperty(tool.details, 'durationMs')
  if (details !== undefined) return details
  const started = findNumberProperty(tool.details, 'startedAt')
  const ended = findNumberProperty(tool.details, 'endedAt')
  if (started !== undefined && ended !== undefined) return Math.max(0, ended - started)
  return undefined
}

export function buildToolActivityPreview(
  tool: ToolRun,
  presentation: ToolPresentation,
  options: TranscriptVisibilityOptions = { detailed: false },
): ToolActivityPreview {
  const maxLines = options.maxPreviewLines ?? (options.detailed ? DETAILED_PREVIEW_MAX_LINES : BALANCED_PREVIEW_MAX_LINES)
  const phase = toolActivityPhase(tool)
  const merged = mergeToolArgs(tool.args, tool.argsText)
  const durationMs = toolDurationMs(tool, presentation)

  if (presentation.fabric) {
    return buildFabricActivityPreview(tool, presentation, merged, phase, durationMs, maxLines)
  }

  if (tool.name === 'read') return buildReadPreview(tool, presentation, merged, phase, durationMs, maxLines)
  if (tool.name === 'edit' || tool.name === 'write') return buildEditPreview(tool, presentation, merged, phase, durationMs, maxLines)
  if (tool.name === 'bash') return buildBashPreview(tool, presentation, merged, phase, durationMs, maxLines)
  if (tool.name === 'grep' || tool.name === 'find') return buildSearchPreview(tool, presentation, merged, phase, durationMs, maxLines)

  const title = presentation.title ?? headlineArg(merged) ?? tool.name
  const content = presentation.content
  return {
    phase,
    title,
    statusLabel: toolStatusLabel(tool),
    ...optField('durationMs', durationMs),
    ...optField('language', presentation.language),
    ...optField('path', presentation.path),
    ...optField('excerpt', boundedExcerpt(content, maxLines)),
    ...(phase === 'preparing' ? { preparingLabel: 'Preparing call…' } : {}),
  }
}

export function isTurnMetricsTimelineItem(item: { kind: string; source?: string | undefined; text?: string }): boolean {
  if (item.kind === 'turn-metrics') return true
  return item.kind === 'context-injection' && item.source === 'turn metrics'
}

export function turnMetricsTimelineText(item: { kind: string; text?: string }): string | undefined {
  if (!isTurnMetricsTimelineItem(item)) return undefined
  const text = typeof item.text === 'string' ? item.text.trim() : ''
  return text || undefined
}

export function traceTurnMetricsText(items: ReadonlyArray<{ kind: string; source?: string | undefined; text?: string }>): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const text = turnMetricsTimelineText(items[index]!)
    if (text) return text
  }
  return undefined
}

export function traceItemsWithoutTurnMetrics<T extends { kind: string; source?: string | undefined }>(items: readonly T[]): T[] {
  return items.filter((item) => !isTurnMetricsTimelineItem(item))
}

function buildFabricActivityPreview(
  tool: ToolRun,
  presentation: ToolPresentation,
  merged: Record<string, unknown>,
  phase: ToolActivityPhase,
  durationMs: number | undefined,
  maxLines: number,
): ToolActivityPreview {
  const fabric = presentation.fabric!
  const display = runDisplayRecord(merged.display ?? parsePartialToolArgs(tool.argsText ?? '').display)
  const name = fabric.name || display.name || 'Fabric execution'
  const description = fabric.description || display.description
  const code = typeof merged.code === 'string'
    ? merged.code
    : typeof fabric.code === 'string'
      ? fabric.code
      : extractPartialJsonString(tool.argsText ?? '', 'code') ?? ''
  const children = fabric.audits.map((audit) => fabricChildPreview(audit, maxLines))
  const completed = children.filter((child) => child.phase === 'complete').length
  const failed = children.filter((child) => child.phase === 'failed').length
  const running = children.filter((child) => child.phase === 'running' || child.phase === 'preparing').length
  return {
    phase,
    title: name,
    ...(description ? { subtitle: description } : {}),
    statusLabel: toolStatusLabel(tool),
    ...optField('durationMs', durationMs),
    ...(phase === 'preparing' ? { preparingLabel: 'Preparing Fabric call…' } : {}),
    fabric: {
      name,
      ...(description ? { description } : {}),
      ...optField('codeExcerpt', code ? boundedExcerpt(code, Math.min(4, maxLines)) : undefined),
      children,
      completed,
      failed,
      running,
    },
  }
}

function fabricChildPreview(audit: FabricAuditPresentation, maxLines: number): FabricChildActivityPreview {
  const phase: ToolActivityPhase = audit.success === false
    ? 'failed'
    : audit.success === true
      ? 'complete'
      : 'running'
  const path = typeof audit.args?.path === 'string' ? audit.args.path : undefined
  const offset = typeof audit.args?.offset === 'number' ? audit.args.offset : undefined
  const limit = typeof audit.args?.limit === 'number' ? audit.args.limit : undefined
  const rangeLabel = path && (offset !== undefined || limit !== undefined)
    ? formatRange(offset ?? 1, limit !== undefined && offset !== undefined ? offset + limit - 1 : limit)
    : undefined
  const resultText = formatAuditResult(audit)
  const toolName = [audit.provider, audit.tool].filter(Boolean).join('.') || audit.ref
  const detail = headlineArg(audit.args)
  return {
    ref: audit.ref,
    title: detail ? `${toolName} ${detail}` : toolName,
    phase,
    ...optField('durationMs', audit.durationMs),
    ...optField('path', path),
    ...optField('rangeLabel', rangeLabel),
    ...optField('excerpt', resultText ? boundedExcerpt(resultText, maxLines) : undefined),
  }
}

function buildReadPreview(
  tool: ToolRun,
  presentation: ToolPresentation,
  merged: Record<string, unknown>,
  phase: ToolActivityPhase,
  durationMs: number | undefined,
  maxLines: number,
): ToolActivityPreview {
  const path = stringProperty(merged, 'path') || presentation.path || ''
  const offset = numberProperty(merged, 'offset')
  const limit = numberProperty(merged, 'limit')
  const rangeLabel = path ? formatRange(offset ?? 1, limit !== undefined && offset !== undefined ? offset + limit - 1 : limit) : undefined
  const content = presentation.content
  const numbered = numberExcerpt(content, offset ?? 1, maxLines)
  return {
    phase,
    title: path || 'Read file',
    statusLabel: toolStatusLabel(tool),
    ...optField('durationMs', durationMs),
    ...optField('path', path || undefined),
    ...optField('rangeLabel', rangeLabel),
    ...optField('language', languageForPath(path)),
    ...optField('excerpt', numbered),
    ...(phase === 'preparing' ? { preparingLabel: 'Preparing read…' } : {}),
  }
}

function buildEditPreview(
  tool: ToolRun,
  presentation: ToolPresentation,
  merged: Record<string, unknown>,
  phase: ToolActivityPhase,
  durationMs: number | undefined,
  maxLines: number,
): ToolActivityPreview {
  const path = stringProperty(merged, 'path') || presentation.path || ''
  const diff = presentation.kind === 'diff' ? presentation.content : undefined
  return {
    phase,
    title: path || 'Edited file',
    statusLabel: toolStatusLabel(tool),
    ...optField('durationMs', durationMs),
    ...optField('path', path || undefined),
    ...optField('diffExcerpt', diff ? boundedExcerpt(diff, maxLines) : boundedExcerpt(presentation.content, maxLines)),
    ...(phase === 'preparing' ? { preparingLabel: 'Preparing edit…' } : {}),
  }
}

function buildBashPreview(
  tool: ToolRun,
  presentation: ToolPresentation,
  merged: Record<string, unknown>,
  phase: ToolActivityPhase,
  durationMs: number | undefined,
  maxLines: number,
): ToolActivityPreview {
  const command = stringProperty(merged, 'command') || presentation.title || ''
  const output = presentation.content
  const tailLines = output.trim().split('\n')
  const tailSource = tailLines.slice(-maxLines).join('\n')
  return {
    phase,
    title: command || 'Command',
    statusLabel: toolStatusLabel(tool),
    ...optField('durationMs', durationMs),
    language: 'bash',
    ...optField('excerpt', command ? boundedExcerpt(command, 3) : undefined),
    ...optField('outputTail', output ? boundedExcerpt(tailSource, maxLines) : undefined),
    ...(phase === 'preparing' ? { preparingLabel: 'Preparing command…' } : {}),
  }
}

function buildSearchPreview(
  tool: ToolRun,
  presentation: ToolPresentation,
  merged: Record<string, unknown>,
  phase: ToolActivityPhase,
  durationMs: number | undefined,
  maxLines: number,
): ToolActivityPreview {
  const pattern = stringProperty(merged, 'pattern') || stringProperty(merged, 'query') || presentation.title || tool.name
  const output = presentation.content
  const lines = output.split('\n').filter(Boolean)
  const matchTotal = lines.length
  return {
    phase,
    title: pattern,
    statusLabel: toolStatusLabel(tool),
    ...optField('durationMs', durationMs),
    ...optField('matchLines', output ? boundedExcerpt(lines.slice(0, maxLines).join('\n'), maxLines) : undefined),
    ...optField('matchTotal', matchTotal || undefined),
    ...(phase === 'preparing' ? { preparingLabel: 'Preparing search…' } : {}),
  }
}

function numberExcerpt(content: string, startLine: number, maxLines: number): BoundedExcerpt | undefined {
  const excerpt = boundedExcerpt(content, maxLines)
  if (!excerpt) return undefined
  const numbered = excerpt.text.split('\n').map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`).join('\n')
  return { ...excerpt, text: numbered }
}

function formatRange(start: number, end?: number): string {
  if (end !== undefined && end !== start) return `L${start}-${end}`
  return `L${start}`
}

function languageForPath(path: string): string | undefined {
  if (path.endsWith('.ts') || path.endsWith('.tsx')) return 'typescript'
  if (path.endsWith('.js') || path.endsWith('.jsx')) return 'javascript'
  if (path.endsWith('.json')) return 'json'
  if (path.endsWith('.md')) return 'markdown'
  return undefined
}

function formatAuditResult(audit: FabricAuditPresentation): string {
  if (typeof audit.error === 'string' && audit.error.trim()) return audit.error
  if (typeof audit.result === 'string') return audit.result
  if (audit.result === undefined || audit.result === null) return ''
  try {
    return JSON.stringify(audit.result, null, 2)
  } catch {
    return String(audit.result)
  }
}

function runDisplayRecord(value: unknown): { name: string; description?: string } {
  if (typeof value === 'string') {
    try {
      return runDisplayRecord(JSON.parse(value))
    } catch {
      return { name: value.trim() }
    }
  }
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  const description = typeof record.description === 'string' ? record.description.trim() : ''
  return { name, ...(description ? { description } : {}) }
}

function extractPartialJsonString(raw: string, key: string, nestedKey?: string): string | undefined {
  const pattern = nestedKey
    ? new RegExp(`"${key}"\\s*:\\s*\\{[^}]*"${nestedKey}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's')
    : new RegExp(`"${key}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, 's')
  const match = raw.match(pattern)
  if (!match?.[1]) return undefined
  try {
    return JSON.parse(`"${match[1]}"`) as string
  } catch {
    return match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
}

function stringProperty(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  return typeof value === 'string' ? value : ''
}

function numberProperty(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function findNumberProperty(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const direct = (value as Record<string, unknown>)[key]
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  for (const child of Object.values(value as Record<string, unknown>)) {
    const found = findNumberProperty(child, key)
    if (found !== undefined) return found
  }
  return undefined
}
