import type { PiSessionSummary } from '../pi/session-catalog.ts'
import { queueLaneItems, queuedInputControl, type QueueLane, type QueuedControl, type QueuedInput } from '../workbench/queue.ts'
import type { ThreadPriority, WorkbenchState } from '../workbench/state.ts'
import { contentText } from '../workbench/state.ts'
import { sessionLifecycleBucket } from '../workbench/thread-lifecycle.ts'
import { taskPromptFromSession } from './compiler.ts'
import { parseFlowSessionName, type FlowMode, type FlowSource } from './types.ts'

export type FlowTaskStatus = 'queued' | 'paused' | 'starting' | 'running' | 'succeeded' | 'failed'

export interface FlowTaskProjection {
  id: string
  runId: string
  title: string
  prompt: string
  mode: FlowMode | 'observed' | 'queue'
  source: FlowSource
  status: FlowTaskStatus
  workspacePath: string
  createdAt: number
  updatedAt: number
  taskIndex: number
  taskCount: number
  scheduleId?: string | undefined
  model?: string | undefined
  session?: PiSessionSummary | undefined
  result?: string | undefined
  stopReason?: string | undefined
  metadataKey: string
  priority: ThreadPriority
  priorityOverridden: boolean
  labels: string[]
  unread: boolean
  settled: boolean
  queueItemIds: string[]
  queueLane?: QueueLane | undefined
}

export interface FlowRunProjection {
  id: string
  source: FlowSource
  title: string
  tasks: FlowTaskProjection[]
  updatedAt: number
}

export function projectFlowRuns(state: WorkbenchState, now = Date.now()): FlowRunProjection[] {
  const tasks = new Map<string, FlowTaskProjection>()
  const uncorrelated = state.queue.items.filter((item) => !item.flow)
  for (const lane of ['steer', 'followUp'] as const) {
    const laneItems = queueLaneItems(uncorrelated, lane)
    const runId = `queue:${lane}`
    laneItems.forEach((item, taskIndex) => {
      const control = queuedInputControl(item)
      const dispatching = state.queue.dispatchingId === item.id
      const createdAt = item.createdAt
      tasks.set(`queue:${item.id}`, {
        id: item.id,
        runId,
        title: queuedTaskTitle(item, control),
        prompt: item.text,
        mode: 'queue',
        source: 'queue',
        status: state.queue.paused || item.paused ? 'paused' : dispatching ? state.queue.blockingActivity ? 'running' : 'starting' : 'queued',
        workspacePath: state.workspacePath,
        createdAt,
        updatedAt: createdAt,
        taskIndex,
        taskCount: laneItems.length,
        ...(control?.kind === 'model' && control.target ? { model: control.target } : {}),
        ...taskProjectionMetadata(`queue:${item.id}`, createdAt, createdAt, undefined, state, now, false),
        queueItemIds: [item.id],
        queueLane: lane,
      })
    })
  }
  for (const item of state.queue.items) {
    const flow = item.flow
    if (!flow) continue
    const current = tasks.get(flow.taskId)
    const prompt = flow.phase === 'prompt' ? taskPromptFromSession(item.text) : current?.prompt ?? ''
    const dispatching = state.queue.dispatchingId === item.id
    tasks.set(flow.taskId, {
      id: flow.taskId,
      runId: flow.runId,
      title: flow.title,
      prompt,
      mode: flow.mode,
      source: flow.source,
      status: state.queue.paused ? 'paused' : dispatching ? 'starting' : current?.status ?? 'queued',
      workspacePath: state.workspacePath,
      createdAt: current?.createdAt ?? item.createdAt,
      updatedAt: Math.max(current?.updatedAt ?? 0, item.createdAt),
      taskIndex: flow.taskIndex,
      taskCount: flow.taskCount,
      ...(flow.scheduleId ? { scheduleId: flow.scheduleId } : {}),
      ...(current?.model ? { model: current.model } : {}),
      ...taskProjectionMetadata(`flow:${flow.taskId}`, current?.createdAt ?? item.createdAt, Math.max(current?.updatedAt ?? 0, item.createdAt), undefined, state, now, false),
      queueItemIds: [...(current?.queueItemIds ?? []), item.id],
    })
  }

  const sessions = [...state.sessions]
  const current = syntheticCurrentSession(state)
  if (current) {
    const currentIndex = sessions.findIndex((session) => session.id === current.id || session.path === current.path)
    if (currentIndex >= 0) sessions[currentIndex] = { ...sessions[currentIndex]!, ...current, createdAt: sessions[currentIndex]!.createdAt }
    else sessions.unshift(current)
  }
  const observedPositions = observedSessionPositions(sessions)
  for (const session of sessions) {
    const parsed = parseFlowSessionName(session.name)
    if (parsed) {
      const queued = tasks.get(parsed.taskId)
      const active = session.id === state.session.sessionId || session.path === state.session.sessionFile
      const status = active && state.session.isStreaming ? 'running' : sessionStatus(session)
      tasks.set(parsed.taskId, {
        id: parsed.taskId,
        runId: parsed.runId,
        title: parsed.title,
        prompt: taskPromptFromSession(session.firstMessage || queued?.prompt || ''),
        mode: session.firstMessage.startsWith('[Flow ') ? 'parallel' : queued?.mode ?? 'sequential',
        source: parsed.source,
        status,
        workspacePath: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.modifiedAt,
        taskIndex: parsed.taskIndex,
        taskCount: parsed.taskCount,
        ...(parsed.scheduleId ? { scheduleId: parsed.scheduleId } : {}),
        ...(active && state.session.model ? { model: `${state.session.model.provider}/${state.session.model.id}` } : queued?.model ? { model: queued.model } : {}),
        session,
        ...(session.lastAssistantText ? { result: session.lastAssistantText } : {}),
        ...(session.lastAssistantStopReason ? { stopReason: session.lastAssistantStopReason } : {}),
        ...taskProjectionMetadata(session.path, session.createdAt, session.modifiedAt, session, state, now, status === 'succeeded' || status === 'failed'),
        queueItemIds: queued?.queueItemIds ?? [],
      })
      continue
    }
    if (session.messageCount === 0) continue
    const active = session.id === state.session.sessionId || session.path === state.session.sessionFile
    const status = active && state.session.isStreaming ? 'running' : sessionStatus(session)
    const id = `PI-${session.id.slice(0, 8).toUpperCase()}`
    const position = observedPositions.get(session.path)
    tasks.set(`observed:${session.id}`, {
      id,
      runId: position?.runId ?? `observed:${session.id}`,
      title: session.title,
      prompt: session.firstMessage,
      mode: 'observed',
      source: 'observed',
      status,
      workspacePath: session.cwd,
      createdAt: session.createdAt,
      updatedAt: session.modifiedAt,
      taskIndex: position?.taskIndex ?? 0,
      taskCount: position?.taskCount ?? 1,
      session,
      ...(session.lastAssistantText ? { result: session.lastAssistantText } : {}),
      ...(session.lastAssistantStopReason ? { stopReason: session.lastAssistantStopReason } : {}),
      ...taskProjectionMetadata(session.path, session.createdAt, session.modifiedAt, session, state, now, status === 'succeeded' || status === 'failed'),
      queueItemIds: [],
    })
  }

  const runs = new Map<string, FlowRunProjection>()
  for (const task of tasks.values()) {
    const currentRun = runs.get(task.runId)
    if (!currentRun) {
      const title = task.source === 'queue'
        ? task.queueLane === 'steer' ? 'Steering queue' : 'Follow-up queue'
        : task.taskCount > 1 ? task.title.replace(/ · Step \d+$/, '') : task.title
      runs.set(task.runId, { id: task.runId, source: task.source, title, tasks: [task], updatedAt: task.updatedAt })
    } else {
      currentRun.tasks.push(task)
      currentRun.updatedAt = Math.max(currentRun.updatedAt, task.updatedAt)
    }
  }
  return [...runs.values()]
    .map((run) => {
      const sortedTasks = run.tasks.toSorted((left, right) => left.taskIndex - right.taskIndex || left.createdAt - right.createdAt)
      return { ...run, ...(run.source === 'observed' && sortedTasks.length > 1 ? { title: sortedTasks[0]!.title } : {}), tasks: sortedTasks }
    })
    .toSorted((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id))
}

export function priorityForSessionDuration(createdAt: number, updatedAt: number): ThreadPriority {
  const duration = Math.max(0, updatedAt - createdAt)
  if (duration >= 2 * 60 * 60 * 1_000) return 1
  if (duration >= 30 * 60 * 1_000) return 2
  if (duration >= 5 * 60 * 1_000) return 3
  return 4
}

export function terminalFlowTasks(runs: readonly FlowRunProjection[]): FlowTaskProjection[] {
  return runs.flatMap((run) => run.tasks).filter((task) => task.status === 'succeeded' || task.status === 'failed').toSorted((left, right) => right.updatedAt - left.updatedAt)
}

function taskProjectionMetadata(
  key: string,
  createdAt: number,
  updatedAt: number,
  session: PiSessionSummary | undefined,
  state: WorkbenchState,
  now: number,
  terminal: boolean,
): Pick<FlowTaskProjection, 'metadataKey' | 'priority' | 'priorityOverridden' | 'labels' | 'unread' | 'settled'> {
  const metadata = state.threadLifecycle[key]
  return {
    metadataKey: key,
    priority: metadata?.priority ?? priorityForSessionDuration(createdAt, updatedAt),
    priorityOverridden: metadata?.priority !== undefined,
    labels: [...(metadata?.labels ?? [])],
    unread: terminal && (metadata?.readAt ?? 0) < updatedAt,
    settled: session ? sessionLifecycleBucket(session, metadata, now) === 'settled' : false,
  }
}

interface ObservedSessionPosition {
  runId: string
  taskIndex: number
  taskCount: number
}

function observedSessionPositions(sessions: readonly PiSessionSummary[]): Map<string, ObservedSessionPosition> {
  const candidates = sessions.filter((session) => session.messageCount > 0 && !parseFlowSessionName(session.name))
  const byPath = new Map(candidates.map((session) => [session.path, session]))
  const parentOf = (session: PiSessionSummary): PiSessionSummary | undefined => {
    const parent = session.parentSession ? byPath.get(session.parentSession) : undefined
    return parent?.cwd === session.cwd ? parent : undefined
  }
  const rootCache = new Map<string, string>()
  const rootPath = (session: PiSessionSummary): string => {
    const trail: PiSessionSummary[] = []
    const seen = new Set<string>()
    let current = session
    let root: string
    while (true) {
      const cached = rootCache.get(current.path)
      if (cached) {
        root = cached
        break
      }
      if (seen.has(current.path)) {
        root = trail.map(({ path }) => path).toSorted()[0] ?? session.path
        break
      }
      seen.add(current.path)
      trail.push(current)
      const parent = parentOf(current)
      if (!parent) {
        root = current.path
        break
      }
      current = parent
    }
    for (const entry of trail) rootCache.set(entry.path, root)
    return root
  }
  const depthCache = new Map<string, number>()
  const depth = (session: PiSessionSummary): number => {
    const trail: PiSessionSummary[] = []
    const seen = new Set<string>()
    let current = session
    let value = -1
    while (true) {
      const cached = depthCache.get(current.path)
      if (cached !== undefined) {
        value = cached
        break
      }
      if (seen.has(current.path)) break
      seen.add(current.path)
      trail.push(current)
      const parent = parentOf(current)
      if (!parent) break
      current = parent
    }
    for (let index = trail.length - 1; index >= 0; index -= 1) {
      value += 1
      depthCache.set(trail[index]!.path, value)
    }
    return depthCache.get(session.path) ?? 0
  }
  const groups = new Map<string, PiSessionSummary[]>()
  for (const session of candidates) {
    const root = rootPath(session)
    const group = groups.get(root)
    if (group) group.push(session)
    else groups.set(root, [session])
  }
  const positions = new Map<string, ObservedSessionPosition>()
  for (const group of groups.values()) {
    const ordered = group.toSorted((left, right) => depth(left) - depth(right) || left.createdAt - right.createdAt || left.path.localeCompare(right.path))
    const root = ordered[0]!
    const runId = ordered.length > 1 ? `observed-chain:${root.id}` : `observed:${root.id}`
    ordered.forEach((session, taskIndex) => positions.set(session.path, { runId, taskIndex, taskCount: ordered.length }))
  }
  return positions
}

function queuedTaskTitle(item: QueuedInput, control: QueuedControl | undefined): string {
  if (!control) return compactObservedTitle(item.text || 'Image attachment')
  if (control.kind === 'new') return 'New session'
  if (control.kind === 'model') return control.target ? `Use ${control.target}` : 'Choose model'
  if (control.kind === 'thinking') return control.level ? `Thinking · ${control.level}` : 'Choose thinking level'
  if (control.kind === 'compact') return 'Compact context'
  if (control.kind === 'reload') return 'Reload resources'
  if (control.kind === 'fabric-prewalk') return 'Fabric prewalk'
  if (control.kind === 'fabric-await') return control.peer ? `Wait for ${control.peer}` : 'Wait for Fabric peers'
  return `/${control.name}${control.argument ? ` ${control.argument}` : ''}`
}

function sessionStatus(session: PiSessionSummary): FlowTaskStatus {
  if (!session.lastAssistantText && !session.lastAssistantStopReason) return 'starting'
  if (session.lastAssistantStopReason === 'toolUse' || session.lastAssistantStopReason === 'tool_use') return 'starting'
  return session.lastAssistantStopReason === 'error' || session.lastAssistantStopReason === 'aborted' || session.lastAssistantStopReason === 'length' ? 'failed' : 'succeeded'
}

function syntheticCurrentSession(state: WorkbenchState): PiSessionSummary | undefined {
  const id = state.session.sessionId
  const name = state.session.sessionName
  const firstUser = state.messages.find((message) => message.role === 'user')
  if (!id || (!name && !firstUser)) return undefined
  const assistants = state.messages.filter((message) => message.role === 'assistant')
  const lastAssistant = assistants.at(-1)
  const createdAt = Number(firstUser?.timestamp ?? Date.now())
  return {
    id,
    path: state.session.sessionFile ?? `current:${id}`,
    cwd: state.workspacePath,
    title: name ?? compactObservedTitle(firstUser ? contentText(firstUser.content) : 'New thread'),
    ...(name ? { name } : {}),
    firstMessage: firstUser ? contentText(firstUser.content) : '',
    messageCount: state.messages.length,
    createdAt,
    modifiedAt: Number(lastAssistant?.timestamp ?? firstUser?.timestamp ?? Date.now()),
    ...(lastAssistant ? { lastAssistantText: contentText(lastAssistant.content).slice(0, 4_000) } : {}),
    ...(typeof lastAssistant?.stopReason === 'string' ? { lastAssistantStopReason: lastAssistant.stopReason } : {}),
  }
}

function compactObservedTitle(value: string): string {
  const firstLine = value.split('\n', 1)[0]?.trim() || 'New thread'
  return firstLine.length > 72 ? `${firstLine.slice(0, 69)}…` : firstLine
}
