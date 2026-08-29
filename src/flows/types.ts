import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'

export type FlowMode = 'sequential' | 'parallel'
export type FlowSource = 'manual' | 'scheduled' | 'observed'

export interface FlowTemplate {
  title: string
  prompts: string[]
  mode: FlowMode
  model?: string | undefined
  workspacePath: string
}

export interface FlowLaunch extends FlowTemplate {
  id: string
  source: Exclude<FlowSource, 'observed'>
  scheduleId?: string | undefined
  createdAt: number
}

export type FlowQueuePhase = 'new-session' | 'set-model' | 'set-name' | 'prompt'

export interface FlowQueueMetadata {
  runId: string
  taskId: string
  title: string
  mode: FlowMode
  source: Exclude<FlowSource, 'observed'>
  scheduleId?: string | undefined
  taskIndex: number
  taskCount: number
  phase: FlowQueuePhase
}

export type FlowScheduleTiming =
  | { kind: 'once'; at: number }
  | { kind: 'interval'; everyMinutes: number; anchorAt: number }
  | { kind: 'daily'; hour: number; minute: number }

export interface FlowSchedule extends FlowTemplate {
  id: string
  timing: FlowScheduleTiming
  enabled: boolean
  createdAt: number
  updatedAt: number
  nextRunAt?: number | undefined
  lastRunAt?: number | undefined
}

export interface FlowScheduleInput extends FlowTemplate {
  timing: FlowScheduleTiming
  enabled?: boolean | undefined
}

export interface FlowRuntimeSnapshot {
  schedules: readonly FlowSchedule[]
  pending: readonly FlowLaunch[]
  lastError?: string | undefined
}

export interface ParsedFlowSessionName {
  runId: string
  taskId: string
  title: string
  source: Exclude<FlowSource, 'observed'>
  scheduleId?: string | undefined
  taskIndex: number
  taskCount: number
}

export function createFlowId(prefix: 'HW' | 'SCH', now = Date.now()): string {
  const time = now.toString(36).slice(-6).toUpperCase()
  const entropy = randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase()
  return `${prefix}-${time}${entropy}`
}

export function normalizeFlowTemplate(input: FlowTemplate): FlowTemplate {
  const title = input.title.trim() || compactPromptTitle(input.prompts[0] ?? '') || 'Untitled flow'
  const prompts = input.prompts.map((prompt) => prompt.trim()).filter(Boolean)
  if (prompts.length === 0) throw new Error('A flow needs at least one prompt')
  return {
    title,
    prompts: input.mode === 'parallel' ? [prompts.join('\n\n')] : prompts,
    mode: input.mode,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    workspacePath: input.workspacePath,
  }
}

export function formatFlowSessionName(launch: FlowLaunch, taskIndex: number): string {
  const taskNumber = taskIndex + 1
  const taskTitle = launch.prompts.length > 1 ? `${launch.title} · Step ${taskNumber}` : launch.title
  const identity = launch.source === 'scheduled' && launch.scheduleId
    ? `Scheduled ${launch.scheduleId}@${launch.id}`
    : `Flow ${launch.id}`
  return `${identity}/${taskNumber}:${launch.prompts.length} · ${compactSessionTitle(taskTitle)}`
}

export function parseFlowSessionName(name: string | undefined): ParsedFlowSessionName | undefined {
  if (!name) return undefined
  const scheduled = /^Scheduled ([A-Za-z0-9-]+)@([A-Za-z0-9-]+)\/(\d+):(\d+) · (.+)$/.exec(name)
  if (scheduled) {
    const scheduleId = scheduled[1]!
    const runId = scheduled[2]!
    const taskIndex = Math.max(0, Number(scheduled[3]) - 1)
    const taskCount = Math.max(1, Number(scheduled[4]))
    return { runId, taskId: `${runId}-${taskIndex + 1}`, title: scheduled[5]!, source: 'scheduled', scheduleId, taskIndex, taskCount }
  }
  const manual = /^Flow ([A-Za-z0-9-]+)\/(\d+):(\d+) · (.+)$/.exec(name)
  if (!manual) return undefined
  const runId = manual[1]!
  const taskIndex = Math.max(0, Number(manual[2]) - 1)
  const taskCount = Math.max(1, Number(manual[3]))
  return { runId, taskId: `${runId}-${taskIndex + 1}`, title: manual[4]!, source: 'manual', taskIndex, taskCount }
}

export function nextScheduleRun(timing: FlowScheduleTiming, after: number): number | undefined {
  if (timing.kind === 'once') return timing.at > after ? timing.at : undefined
  if (timing.kind === 'interval') {
    const interval = Math.max(1, timing.everyMinutes) * 60_000
    if (timing.anchorAt > after) return timing.anchorAt
    return timing.anchorAt + (Math.floor((after - timing.anchorAt) / interval) + 1) * interval
  }
  const candidate = new Date(after)
  candidate.setHours(timing.hour, timing.minute, 0, 0)
  if (candidate.getTime() <= after) candidate.setDate(candidate.getDate() + 1)
  return candidate.getTime()
}

export function initialScheduleRun(timing: FlowScheduleTiming, now: number): number | undefined {
  if (timing.kind === 'once') return timing.at >= now ? timing.at : undefined
  if (timing.kind === 'interval' && timing.anchorAt >= now) return timing.anchorAt
  return nextScheduleRun(timing, now - 1)
}

export function scheduleTimingLabel(timing: FlowScheduleTiming): string {
  if (timing.kind === 'once') return `Once · ${formatFlowDate(timing.at)}`
  if (timing.kind === 'interval') return `Every ${timing.everyMinutes} min`
  return `Daily · ${String(timing.hour).padStart(2, '0')}:${String(timing.minute).padStart(2, '0')}`
}

export function formatFlowDate(value: number): string {
  return new Date(value).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function compactPromptTitle(prompt: string): string {
  const firstLine = prompt.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.length > 64 ? `${firstLine.slice(0, 61)}…` : firstLine
}

export function flowProjectName(workspacePath: string): string {
  return basename(workspacePath) || workspacePath
}

function compactSessionTitle(title: string): string {
  const compact = title.replace(/\s+/g, ' ').trim()
  return compact.length > 88 ? `${compact.slice(0, 85)}…` : compact
}
