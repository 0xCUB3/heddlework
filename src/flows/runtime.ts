import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { WorkbenchState } from '../workbench/state.ts'
import type { QueueInputDraft } from '../workbench/queue.ts'
import { compileFlowTask, normalizedLaunch } from './compiler.ts'
import { readyTasks } from './graph.ts'
import { sessionStatus } from './projection.ts'
import type { CheckoutLaneService } from '../workspace/checkout-lanes.ts'
import {
  createFlowId,
  initialScheduleRun,
  nextScheduleRun,
  normalizeFlowTemplate,
  type FlowLaunch,
  type FlowRunRecord,
  type FlowRuntimeSnapshot,
  type FlowSchedule,
  type FlowScheduleInput,
  type FlowTaskRecord,
  type FlowTemplate,
  parseFlowSessionName,
} from './types.ts'

export interface FlowRuntimeHost {
  subscribe(listener: () => void): () => void
  getSnapshot(): WorkbenchState
  enqueueQueueInputs(inputs: readonly QueueInputDraft[], options?: { start?: boolean }): void
  hasQueuedFlow(runId: string): boolean
  notify(kind: 'info' | 'warning' | 'error', message: string): void
}

export interface FlowRuntimeOptions {
  path?: string | false | undefined
  now?: (() => number) | undefined
  createId?: ((prefix: 'HW' | 'SCH', now: number) => string) | undefined
  tickIntervalMs?: number | undefined
  lanes?: CheckoutLaneService | undefined
}

interface FlowRuntimeDocument {
  version: 1
  schedules: FlowSchedule[]
  pending: FlowLaunch[]
  runs: FlowRunRecord[]
}

export class FlowRuntime {
  readonly #host: FlowRuntimeHost
  readonly #path: string | false
  readonly #now: () => number
  readonly #createId: (prefix: 'HW' | 'SCH', now: number) => string
  readonly #tickIntervalMs: number
  readonly #lanes: CheckoutLaneService | undefined
  readonly #listeners = new Set<() => void>()
  #document: FlowRuntimeDocument
  #snapshot: FlowRuntimeSnapshot
  #timer: ReturnType<typeof setInterval> | undefined
  #unsubscribeHost: (() => void) | undefined
  #flushing: Promise<void> | undefined
  #flushAgain = false

  constructor(host: FlowRuntimeHost, options: FlowRuntimeOptions = {}) {
    this.#host = host
    this.#path = options.path === undefined ? flowRuntimePath() : options.path
    this.#now = options.now ?? (() => Date.now())
    this.#createId = options.createId ?? createFlowId
    this.#tickIntervalMs = options.tickIntervalMs ?? 1_000
    this.#lanes = options.lanes
    this.#document = readRuntimeDocument(this.#path)
    this.#snapshot = snapshotFrom(this.#document)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): FlowRuntimeSnapshot => this.#snapshot

  start(): void {
    if (this.#timer) return
    this.#unsubscribeHost = this.#host.subscribe(() => { void this.flushPending() })
    this.#timer = setInterval(() => { void this.tick() }, this.#tickIntervalMs)
    this.#timer.unref?.()
    void this.tick()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#unsubscribeHost?.()
    this.#unsubscribeHost = undefined
    this.#listeners.clear()
  }

  createSchedule(input: FlowScheduleInput): FlowSchedule {
    const now = this.#now()
    const template = normalizeFlowTemplate(input)
    const schedule: FlowSchedule = {
      ...template,
      id: this.#createId('SCH', now),
      timing: input.timing,
      enabled: input.enabled ?? true,
      createdAt: now,
      updatedAt: now,
      ...(input.enabled === false ? {} : { nextRunAt: initialScheduleRun(input.timing, now) }),
    }
    if (schedule.enabled && schedule.nextRunAt === undefined) throw new Error('The schedule must run in the future')
    this.#document.schedules.push(schedule)
    this.#commit()
    return schedule
  }

  setScheduleEnabled(id: string, enabled: boolean): void {
    const schedule = this.#document.schedules.find((candidate) => candidate.id === id)
    if (!schedule || schedule.enabled === enabled) return
    const now = this.#now()
    const nextRunAt = enabled ? initialScheduleRun(schedule.timing, now) : undefined
    if (enabled && nextRunAt === undefined) throw new Error('This one-time schedule is already in the past')
    schedule.enabled = enabled
    schedule.updatedAt = now
    schedule.nextRunAt = nextRunAt
    this.#commit()
  }

  removeSchedule(id: string): void {
    const next = this.#document.schedules.filter((schedule) => schedule.id !== id)
    if (next.length === this.#document.schedules.length) return
    this.#document.schedules = next
    this.#document.pending = this.#document.pending.filter((launch) => launch.scheduleId !== id)
    this.#commit()
  }

  // Manual launches enter the same durable pending list as scheduled ones so graph dispatch is uniform.
  launch(template: FlowTemplate): FlowLaunch {
    const now = this.#now()
    const normalized = normalizeFlowTemplate(template)
    const launch: FlowLaunch = { ...normalized, id: this.#createId('HW', now), source: 'manual', createdAt: now }
    this.#document.pending.push(launch)
    this.#commit()
    void this.flushPending()
    return launch
  }

  async mergeLane(laneId: string): Promise<{ merged: true } | { merged: false; message: string }> {
    if (!this.#lanes) return { merged: false, message: 'Checkout lanes are not available' }
    const task = this.#findTaskByLane(laneId)
    const workspacePath = task?.run.workspacePath ?? this.#host.getSnapshot().workspacePath
    const result = await this.#lanes.merge(workspacePath, laneId)
    if (result.merged && task) {
      task.task.laneMerged = true
      this.#commit()
      this.#host.notify('info', `Merged lane ${laneId} into the primary tree`)
    } else if (!result.merged) {
      this.#host.notify('warning', `Lane ${laneId} was not merged: ${result.message}`)
    }
    return result
  }

  async removeLane(laneId: string): Promise<void> {
    if (!this.#lanes) return
    const task = this.#findTaskByLane(laneId)
    await this.#lanes.remove(task?.run.workspacePath ?? this.#host.getSnapshot().workspacePath, laneId)
    if (task) {
      task.task.laneRemoved = true
      this.#commit()
    }
  }

  runScheduleNow(id: string): FlowLaunch | undefined {
    const schedule = this.#document.schedules.find((candidate) => candidate.id === id)
    if (!schedule) return undefined
    const now = this.#now()
    const launch = this.#launchFromSchedule(schedule, now)
    schedule.lastRunAt = now
    schedule.updatedAt = now
    this.#document.pending.push(launch)
    this.#commit()
    void this.flushPending()
    return launch
  }

  async tick(now = this.#now()): Promise<void> {
    let changed = false
    for (const schedule of this.#document.schedules) {
      if (!schedule.enabled || schedule.nextRunAt === undefined || schedule.nextRunAt > now) continue
      const dueAt = schedule.nextRunAt
      const launch = this.#launchFromSchedule(schedule, dueAt)
      if (!this.#document.pending.some((candidate) => candidate.id === launch.id)) this.#document.pending.push(launch)
      schedule.lastRunAt = dueAt
      schedule.updatedAt = now
      schedule.nextRunAt = nextScheduleRun(schedule.timing, now)
      if (schedule.nextRunAt === undefined) schedule.enabled = false
      changed = true
    }
    if (changed) this.#commit()
    await this.flushPending()
  }

  // Concurrent callers share one pass; a call that arrives mid-pass schedules exactly one follow-up pass.
  async flushPending(): Promise<void> {
    if (this.#flushing) {
      this.#flushAgain = true
      await this.#flushing
      return
    }
    const state = this.#host.getSnapshot()
    if (state.connection !== 'connected') return
    this.#flushing = this.#flushOnce()
    try {
      await this.#flushing
    } finally {
      this.#flushing = undefined
    }
    if (this.#flushAgain) {
      this.#flushAgain = false
      await this.flushPending()
    }
  }

  async #flushOnce(): Promise<void> {
    try {
      let changed = false
      for (const launch of [...this.#document.pending]) {
        if (resolve(launch.workspacePath) !== resolve(this.#host.getSnapshot().workspacePath)) continue
        const normalized = normalizedLaunch(launch)
        this.#document.runs.push({
          launch: normalized,
          workspacePath: normalized.workspacePath,
          tasks: (normalized.tasks ?? []).map((spec, index) => ({ specId: spec.id, taskId: `${normalized.id}-${index + 1}`, index, attempt: 0, status: 'pending' })),
        })
        this.#document.pending = this.#document.pending.filter((candidate) => candidate.id !== launch.id)
        this.#host.notify('info', `${launch.source === 'scheduled' ? 'Scheduled flow' : 'Flow'} ${launch.id} queued`)
        changed = true
      }
      if (await this.#dispatchRuns()) changed = true
      if (changed) this.#commit()
    } catch (error) {
      this.#snapshot = { ...snapshotFrom(this.#document), lastError: error instanceof Error ? error.message : String(error) }
      this.#emit()
    }
  }

  // Observes task sessions, retries failed attempts, and enqueues every task whose dependencies have completed.
  async #dispatchRuns(): Promise<boolean> {
    let changed = false
    const state = this.#host.getSnapshot()
    const sessionsByTask = new Map<string, ReturnType<typeof sessionStatus>>()
    for (const session of state.sessions) {
      const parsed = parseFlowSessionName(session.name)
      if (!parsed) continue
      const active = session.id === state.session.sessionId || session.path === state.session.sessionFile
      sessionsByTask.set(parsed.taskId, active && state.session.isStreaming ? 'running' : sessionStatus(session))
    }
    for (const run of this.#document.runs) {
      if (resolve(run.workspacePath) !== resolve(state.workspacePath)) continue
      const specs = run.launch.tasks ?? []
      for (const task of run.tasks) {
        if (task.status !== 'dispatched') continue
        if (state.queue.items.some((item) => item.flow?.taskId === task.taskId)) continue
        const observed = sessionsByTask.get(task.taskId)
        if (observed === 'succeeded') { task.status = 'completed'; changed = true }
        else if (observed === 'failed') {
          const spec = specs[task.index]
          if ((spec?.retries ?? 0) > task.attempt - 1) {
            task.status = 'pending'
            this.#host.notify('warning', `Task ${task.taskId} failed; retrying (attempt ${task.attempt + 1})`)
          } else {
            task.status = 'failed'
          }
          changed = true
        }
      }
      const completed = new Set(run.tasks.filter((task) => task.status === 'completed').map((task) => task.specId))
      const failed = new Set(run.tasks.filter((task) => task.status === 'failed').map((task) => task.specId))
      const readiness = readyTasks(specs, completed, failed)
      for (const blocked of readiness.blocked) {
        const record = run.tasks.find((task) => task.specId === blocked.id)
        if (record && record.status !== 'blocked') { record.status = 'blocked'; changed = true }
      }
      for (const spec of readiness.ready) {
        const record = run.tasks.find((task) => task.specId === spec.id)
        if (!record || record.status !== 'pending') continue
        if (this.#host.getSnapshot().queue.items.some((item) => item.flow?.taskId === record.taskId)) { record.status = 'dispatched'; changed = true; continue }
        record.attempt += 1
        let lanePath: string | undefined
        if (spec.lane === 'worktree' && this.#lanes) {
          const laneId = record.taskId
          const lane = await this.#lanes.create(run.workspacePath, laneId)
          lanePath = lane.path
          record.laneId = laneId
          record.lanePath = lane.path
          record.laneBranch = lane.branch
        }
        this.#host.enqueueQueueInputs(compileFlowTask(run.launch, spec, record.index, { attempt: record.attempt, ...(lanePath ? { lanePath } : {}) }), { start: true })
        record.status = 'dispatched'
        changed = true
      }
    }
    return changed
  }

  #findTaskByLane(laneId: string): { run: FlowRunRecord; task: FlowTaskRecord } | undefined {
    for (const run of this.#document.runs) {
      const task = run.tasks.find((candidate) => candidate.laneId === laneId)
      if (task) return { run, task }
    }
    return undefined
  }

  #launchFromSchedule(schedule: FlowSchedule, now: number): FlowLaunch {
    return {
      id: this.#createId('HW', now),
      title: schedule.title,
      prompts: [...schedule.prompts],
      mode: schedule.mode,
      ...(schedule.model ? { model: schedule.model } : {}),
      workspacePath: schedule.workspacePath,
      ...(schedule.tasks ? { tasks: schedule.tasks.map((task) => ({ ...task })) } : {}),
      source: 'scheduled',
      scheduleId: schedule.id,
      createdAt: now,
    }
  }

  #commit(): void {
    writeRuntimeDocument(this.#path, this.#document)
    this.#snapshot = snapshotFrom(this.#document)
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

export function flowRuntimePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'flows.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'flows.json')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework', 'flows.json')
}

function snapshotFrom(document: FlowRuntimeDocument): FlowRuntimeSnapshot {
  return {
    schedules: document.schedules.map((schedule) => ({ ...schedule, prompts: [...schedule.prompts] })).toSorted((left, right) => (left.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (right.nextRunAt ?? Number.MAX_SAFE_INTEGER)),
    pending: document.pending.map((launch) => ({ ...launch, prompts: [...launch.prompts] })),
    runs: document.runs.map((run) => ({ ...run, tasks: run.tasks.map((task) => ({ ...task })) })),
  }
}

function readRuntimeDocument(path: string | false): FlowRuntimeDocument {
  if (!path) return { version: 1, schedules: [], pending: [], runs: [] }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; schedules?: unknown; pending?: unknown; runs?: unknown }
    return {
      version: 1,
      schedules: Array.isArray(value.schedules) ? value.schedules.filter(isFlowSchedule) : [],
      pending: Array.isArray(value.pending) ? value.pending.filter(isFlowLaunch) : [],
      runs: Array.isArray(value.runs) ? value.runs.filter(isFlowRunRecord) : [],
    }
  } catch {
    return { version: 1, schedules: [], pending: [], runs: [] }
  }
}

function writeRuntimeDocument(path: string | false, document: FlowRuntimeDocument): void {
  if (!path) return
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function isFlowLaunch(value: unknown): value is FlowLaunch {
  if (!value || typeof value !== 'object') return false
  const launch = value as Record<string, unknown>
  return typeof launch.id === 'string' && typeof launch.title === 'string' && Array.isArray(launch.prompts) && launch.prompts.every((prompt) => typeof prompt === 'string') && (launch.mode === 'sequential' || launch.mode === 'parallel') && (launch.source === 'manual' || launch.source === 'scheduled') && typeof launch.workspacePath === 'string' && typeof launch.createdAt === 'number'
}

function isFlowRunRecord(value: unknown): value is FlowRunRecord {
  if (!value || typeof value !== 'object') return false
  const run = value as Record<string, unknown>
  return isFlowLaunch(run.launch) && typeof run.workspacePath === 'string' && Array.isArray(run.tasks)
}

function isFlowSchedule(value: unknown): value is FlowSchedule {
  if (!value || typeof value !== 'object') return false
  const schedule = value as Record<string, unknown>
  return typeof schedule.id === 'string' && typeof schedule.title === 'string' && Array.isArray(schedule.prompts) && schedule.prompts.every((prompt) => typeof prompt === 'string') && (schedule.mode === 'sequential' || schedule.mode === 'parallel') && typeof schedule.workspacePath === 'string' && typeof schedule.enabled === 'boolean' && typeof schedule.createdAt === 'number' && typeof schedule.updatedAt === 'number' && Boolean(schedule.timing) && typeof schedule.timing === 'object'
}
