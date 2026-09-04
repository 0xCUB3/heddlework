
export type FlowMode = 'sequential' | 'parallel'
export type FlowLaunchSource = 'manual' | 'scheduled'
export type FlowSource = FlowLaunchSource | 'observed' | 'queue'

export type FlowLaneKind = 'shared' | 'worktree'

export interface FlowTaskSpec {
  id: string
  prompt: string
  dependsOn?: string[] | undefined
  lane?: FlowLaneKind | undefined
  retries?: number | undefined
}

export interface FlowTemplate {
  title: string
  prompts: string[]
  mode: FlowMode
  model?: string | undefined
  workspacePath: string
  tasks?: FlowTaskSpec[] | undefined
}

export interface FlowLaunch extends FlowTemplate {
  id: string
  source: FlowLaunchSource
  scheduleId?: string | undefined
  createdAt: number
}

export type FlowQueuePhase = 'new-session' | 'set-model' | 'set-name' | 'prompt'

export interface FlowQueueMetadata {
  runId: string
  taskId: string
  title: string
  mode: FlowMode
  source: FlowLaunchSource
  scheduleId?: string | undefined
  taskIndex: number
  taskCount: number
  phase: FlowQueuePhase
  specId?: string | undefined
  dependsOn?: string[] | undefined
  lane?: FlowLaneKind | undefined
  lanePath?: string | undefined
  attempt?: number | undefined
  retries?: number | undefined
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

export type FlowTaskRecordStatus = 'pending' | 'dispatched' | 'completed' | 'failed' | 'blocked'

export interface FlowTaskRecord {
  specId: string
  taskId: string
  index: number
  attempt: number
  status: FlowTaskRecordStatus
  laneId?: string | undefined
  lanePath?: string | undefined
  laneBranch?: string | undefined
  laneMerged?: boolean | undefined
  laneRemoved?: boolean | undefined
}

export interface FlowRunRecord {
  launch: FlowLaunch
  workspacePath: string
  tasks: FlowTaskRecord[]
}

export interface FlowRuntimeSnapshot {
  schedules: readonly FlowSchedule[]
  pending: readonly FlowLaunch[]
  runs: readonly FlowRunRecord[]
  lastError?: string | undefined
}

export interface ParsedFlowSessionName {
  runId: string
  taskId: string
  title: string
  source: FlowLaunchSource
  scheduleId?: string | undefined
  taskIndex: number
  taskCount: number
}

export function createFlowId(prefix: 'HW' | 'SCH', now = Date.now()): string {
  const time = now.toString(36).slice(-6).toUpperCase()
  const entropy = globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase()
  return `${prefix}-${time}${entropy}`
}

export function normalizeFlowTemplate(input: FlowTemplate): FlowTemplate {
  const explicitTasks = input.tasks?.map((task) => ({ ...task, prompt: task.prompt.trim() })).filter((task) => task.prompt) ?? []
  const sourcePrompts = explicitTasks.length > 0 ? explicitTasks.map((task) => task.prompt) : input.prompts
  const title = input.title.trim() || compactPromptTitle(sourcePrompts[0] ?? '') || 'Untitled flow'
  const prompts = sourcePrompts.map((prompt) => prompt.trim()).filter(Boolean)
  if (prompts.length === 0) throw new Error('A flow needs at least one prompt')
  const collapsed = input.mode === 'parallel' ? [prompts.join('\n\n')] : prompts
  const tasks = explicitTasks.length > 0 && input.mode !== 'parallel'
    ? explicitTasks.map((task) => normalizeTaskSpec(task))
    : collapsed.map((prompt, index) => ({
      id: `t${index + 1}`,
      prompt,
      ...(input.mode === 'sequential' && index > 0 ? { dependsOn: [`t${index}`] } : {}),
    }))
  validateFlowGraph(tasks)
  return {
    title,
    prompts: tasks.map((task) => task.prompt),
    mode: input.mode,
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    workspacePath: input.workspacePath,
    tasks,
  }
}

function normalizeTaskSpec(task: FlowTaskSpec): FlowTaskSpec {
  const dependsOn = [...new Set((task.dependsOn ?? []).map((id) => id.trim()).filter(Boolean))]
  return {
    id: task.id.trim(),
    prompt: task.prompt,
    ...(dependsOn.length > 0 ? { dependsOn } : {}),
    ...(task.lane === 'worktree' ? { lane: 'worktree' as const } : {}),
    ...(task.retries && task.retries > 0 ? { retries: Math.min(10, Math.floor(task.retries)) } : {}),
  }
}

// Rejects unknown dependency ids and cycles so a launch can never wait on itself.
export function validateFlowGraph(tasks: readonly FlowTaskSpec[]): void {
  const ids = new Set<string>()
  for (const task of tasks) {
    if (!task.id) throw new Error('Every flow task needs an id')
    if (ids.has(task.id)) throw new Error(`Duplicate flow task id: ${task.id}`)
    ids.add(task.id)
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn ?? []) {
      if (dependency === task.id) throw new Error(`Task ${task.id} depends on itself`)
      if (!ids.has(dependency)) throw new Error(`Task ${task.id} depends on unknown task ${dependency}`)
    }
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const visit = (id: string, trail: string[]): void => {
    const mark = state.get(id)
    if (mark === 'done') return
    if (mark === 'visiting') throw new Error(`Flow task dependencies form a cycle: ${[...trail, id].join(' -> ')}`)
    state.set(id, 'visiting')
    for (const dependency of byId.get(id)?.dependsOn ?? []) visit(dependency, [...trail, id])
    state.set(id, 'done')
  }
  for (const task of tasks) visit(task.id, [])
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
  return basenameOf(workspacePath) || workspacePath
}

function basenameOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '')
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return index === -1 ? trimmed : trimmed.slice(index + 1)
}

function compactSessionTitle(title: string): string {
  const compact = title.replace(/\s+/g, ' ').trim()
  return compact.length > 88 ? `${compact.slice(0, 85)}…` : compact
}
