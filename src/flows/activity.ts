import type { TimelineItem } from '../workbench/timeline.ts'
import type { FlowTaskStatus } from './projection.ts'

export type FlowActivityKind = 'session' | 'prompt' | 'context' | 'tools' | 'response' | 'status'
export type FlowActivityTone = 'normal' | 'success' | 'error'

export interface FlowActivitySubject {
  id: string
  prompt: string
  source: 'manual' | 'scheduled' | 'observed'
  status: FlowTaskStatus
  createdAt: number
  updatedAt: number
  stopReason?: string | undefined
}

export interface FlowActivityEntry {
  id: string
  kind: FlowActivityKind
  title: string
  detail?: string | undefined
  timestamp: number
  tone: FlowActivityTone
}

interface TurnBatch {
  prompt?: Extract<TimelineItem, { kind: 'user' }> | undefined
  contexts: Array<Extract<TimelineItem, { kind: 'context-injection' }>>
  tools: Array<Extract<TimelineItem, { kind: 'tool' }>>
  responses: Array<Extract<TimelineItem, { kind: 'assistant' }>>
  statuses: Array<Extract<TimelineItem, { kind: 'status' | 'notice' }>>
}

const MAX_ACTIVITY_ENTRIES = 32

export function projectFlowActivity(subject: FlowActivitySubject, timeline: readonly TimelineItem[]): FlowActivityEntry[] {
  const entries: FlowActivityEntry[] = [{
    id: `${subject.id}:created`,
    kind: 'session',
    title: 'Session started',
    detail: subject.source === 'scheduled' ? 'Scheduled Flow' : subject.source === 'manual' ? 'Manual Flow' : 'Observed Pi session',
    timestamp: subject.createdAt,
    tone: 'normal',
  }]
  const hasPrompt = timeline.some((item) => item.kind === 'user')
  if (!hasPrompt && subject.prompt.trim()) {
    entries.push({
      id: `${subject.id}:prompt`,
      kind: 'prompt',
      title: 'Prompted Pi',
      detail: compactActivityText(subject.prompt),
      timestamp: subject.createdAt,
      tone: 'normal',
    })
  }

  let turn: TurnBatch | undefined
  let turnIndex = 0
  const flush = () => {
    if (!turn) return
    appendTurn(entries, subject.id, subject.createdAt, turnIndex, turn)
    turnIndex += 1
    turn = undefined
  }

  for (const item of timeline) {
    if (item.kind === 'user') {
      flush()
      turn = emptyTurn(item)
      continue
    }
    turn ??= emptyTurn()
    if (item.kind === 'context-injection') turn.contexts.push(item)
    else if (item.kind === 'tool') turn.tools.push(item)
    else if (item.kind === 'assistant') turn.responses.push(item)
    else if (item.kind === 'status' || item.kind === 'notice') turn.statuses.push(item)
  }
  flush()

  entries.push(statusEntry(subject))
  if (entries.length <= MAX_ACTIVITY_ENTRIES) return entries
  const retained = entries.slice(-(MAX_ACTIVITY_ENTRIES - 2))
  return [
    entries[0]!,
    {
      id: `${subject.id}:grouped`,
      kind: 'session',
      title: `${entries.length - retained.length - 1} earlier events grouped`,
      timestamp: retained[0]?.timestamp ?? subject.createdAt,
      tone: 'normal',
    },
    ...retained,
  ]
}

function emptyTurn(prompt?: Extract<TimelineItem, { kind: 'user' }>): TurnBatch {
  return { prompt, contexts: [], tools: [], responses: [], statuses: [] }
}

function appendTurn(entries: FlowActivityEntry[], subjectId: string, createdAt: number, index: number, turn: TurnBatch): void {
  const fallbackTimestamp = turn.prompt?.timestamp ?? turn.contexts[0]?.timestamp ?? turn.tools[0]?.timestamp ?? turn.responses[0]?.timestamp ?? turn.statuses[0]?.timestamp ?? createdAt
  if (turn.prompt) {
    entries.push({
      id: `${subjectId}:turn:${index}:prompt`,
      kind: 'prompt',
      title: index === 0 ? 'Prompted Pi' : 'Sent a follow-up',
      detail: compactActivityText(turn.prompt.text),
      timestamp: turn.prompt.timestamp ?? fallbackTimestamp,
      tone: 'normal',
    })
  }
  if (turn.contexts.length > 0) {
    const sources = [...new Set(turn.contexts.map((item) => item.source).filter((source): source is string => Boolean(source)))]
    entries.push({
      id: `${subjectId}:turn:${index}:context`,
      kind: 'context',
      title: `Applied ${turn.contexts.length} context update${turn.contexts.length === 1 ? '' : 's'}`,
      ...(sources.length > 0 ? { detail: sources.join(' · ') } : {}),
      timestamp: turn.contexts.at(-1)?.timestamp ?? fallbackTimestamp,
      tone: 'normal',
    })
  }
  if (turn.tools.length > 0) {
    const failures = turn.tools.filter((item) => item.tool.isError).length
    entries.push({
      id: `${subjectId}:turn:${index}:tools`,
      kind: 'tools',
      title: `Ran ${turn.tools.length} tool call${turn.tools.length === 1 ? '' : 's'}`,
      detail: toolBatchDetail(turn.tools, failures),
      timestamp: turn.tools.at(-1)?.timestamp ?? fallbackTimestamp,
      tone: failures > 0 ? 'error' : 'normal',
    })
  }
  if (turn.responses.length > 0) {
    const response = turn.responses.at(-1)!
    entries.push({
      id: `${subjectId}:turn:${index}:response`,
      kind: 'response',
      title: 'Produced a response',
      detail: compactActivityText(response.text),
      timestamp: response.timestamp ?? fallbackTimestamp,
      tone: 'success',
    })
  }
  const errors = turn.statuses.filter((item) => item.kind === 'notice' ? item.notice.kind === 'error' : item.tone === 'error')
  if (errors.length > 0) {
    const last = errors.at(-1)!
    entries.push({
      id: `${subjectId}:turn:${index}:status`,
      kind: 'status',
      title: errors.length === 1 ? 'Recorded an error' : `Recorded ${errors.length} errors`,
      detail: compactActivityText(last.kind === 'notice' ? last.notice.message : last.text),
      timestamp: last.timestamp ?? fallbackTimestamp,
      tone: 'error',
    })
  }
}

function toolBatchDetail(tools: TurnBatch['tools'], failures: number): string {
  const counts = new Map<string, number>()
  for (const item of tools) counts.set(item.tool.name, (counts.get(item.tool.name) ?? 0) + 1)
  const names = [...counts.entries()].map(([name, count]) => count > 1 ? `${name} ×${count}` : name)
  if (failures > 0) names.push(`${failures} failed`)
  return compactActivityText(names.join(' · '), 120)
}

function statusEntry(subject: FlowActivitySubject): FlowActivityEntry {
  if (subject.status === 'succeeded') return { id: `${subject.id}:status`, kind: 'status', title: 'Session completed', timestamp: subject.updatedAt, tone: 'success' }
  if (subject.status === 'failed') return { id: `${subject.id}:status`, kind: 'status', title: 'Session failed', ...(subject.stopReason ? { detail: compactActivityText(subject.stopReason) } : {}), timestamp: subject.updatedAt, tone: 'error' }
  if (subject.status === 'paused') return { id: `${subject.id}:status`, kind: 'status', title: 'Queue paused', timestamp: subject.updatedAt, tone: 'normal' }
  if (subject.status === 'queued') return { id: `${subject.id}:status`, kind: 'status', title: 'Waiting in queue', timestamp: subject.updatedAt, tone: 'normal' }
  return { id: `${subject.id}:status`, kind: 'status', title: subject.status === 'starting' ? 'Session is starting' : 'Session is running', timestamp: subject.updatedAt, tone: 'normal' }
}

function compactActivityText(value: string, limit = 110): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > limit ? `${compact.slice(0, limit - 1)}…` : compact
}
