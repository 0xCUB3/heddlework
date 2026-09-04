import { describe, expect, it } from 'bun:test'
import { FlowRuntime, type FlowRuntimeHost } from '../src/flows/runtime.ts'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { createInitialState, type WorkbenchState } from '../src/workbench/state.ts'
import type { QueueInputDraft } from '../src/workbench/queue.ts'
import type { CheckoutLaneService } from '../src/workspace/checkout-lanes.ts'

class GraphHost implements FlowRuntimeHost {
  state: WorkbenchState
  readonly notifications: string[] = []
  readonly listeners = new Set<() => void>()
  #next = 0

  constructor() {
    this.state = { ...createInitialState('/tmp/flows-graph'), connection: 'connected' }
  }

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  getSnapshot(): WorkbenchState { return this.state }
  hasQueuedFlow(runId: string): boolean { return this.state.queue.items.some((item) => item.flow?.runId === runId) }
  notify(_kind: 'info' | 'warning' | 'error', message: string): void { this.notifications.push(message) }
  enqueueQueueInputs(inputs: readonly QueueInputDraft[]): void {
    this.state = { ...this.state, queue: { ...this.state.queue, items: [...this.state.queue.items, ...inputs.map((input, index) => ({ id: `row-${++this.#next}`, text: input.text, images: [], createdAt: index, ...(input.lane ? { lane: input.lane } : {}), ...(input.flow ? { flow: input.flow } : {}) }))] } }
  }

  queuedTaskIds(): string[] {
    return [...new Set(this.state.queue.items.map((item) => item.flow?.taskId).filter((id): id is string => Boolean(id)))]
  }

  // Simulates Pi finishing a task: its queue rows drain and a named session with an outcome appears.
  finish(taskId: string, name: string, outcome: 'succeeded' | 'failed'): void {
    const items = this.state.queue.items.filter((item) => item.flow?.taskId !== taskId)
    const session: PiSessionSummary = {
      id: `${taskId}-${this.state.sessions.length}`,
      path: `/tmp/sessions/${taskId}-${this.state.sessions.length}.jsonl`,
      cwd: this.state.workspacePath,
      title: name,
      name,
      firstMessage: 'prompt',
      messageCount: 2,
      createdAt: 1,
      modifiedAt: 2,
      lastAssistantText: outcome === 'succeeded' ? 'done' : 'boom',
      lastAssistantStopReason: outcome === 'succeeded' ? 'stop' : 'error',
    }
    this.state = { ...this.state, queue: { ...this.state.queue, items }, sessions: [session, ...this.state.sessions] }
  }
}

function sessionName(runId: string, index: number, count: number, title: string): string {
  return `Flow ${runId}/${index}:${count} · ${title} · Step ${index}`
}

function fakeLanes(): CheckoutLaneService & { created: string[]; removed: string[] } {
  const service = {
    created: [] as string[],
    removed: [] as string[],
    async create(_workspace: string, laneId: string) { service.created.push(laneId); return { id: laneId, path: `/lanes/${laneId}`, branch: `heddlework/${laneId}` } },
    async remove(_workspace: string, laneId: string) { service.removed.push(laneId) },
    async list() { return [] },
    async merge() { return { merged: true as const } },
  }
  return service
}

describe('FlowRuntime graph dispatch', () => {
  it('dispatches B only after A completes and blocks C when its dependency fails after retries', async () => {
    const host = new GraphHost()
    let sequence = 0
    const runtime = new FlowRuntime(host, { path: false, now: () => 1_000, createId: (prefix) => `${prefix}-G${++sequence}`, lanes: fakeLanes() })
    const launch = runtime.launch({
      title: 'Graph',
      prompts: [],
      mode: 'sequential',
      workspacePath: host.state.workspacePath,
      tasks: [
        { id: 'a', prompt: 'Do A' },
        { id: 'b', prompt: 'Do B', dependsOn: ['a'], retries: 1 },
        { id: 'c', prompt: 'Do C', dependsOn: ['b'] },
      ],
    })
    await runtime.flushPending()
    expect(host.queuedTaskIds()).toEqual([`${launch.id}-1`])
    expect(host.state.queue.items.at(-1)?.flow).toMatchObject({ specId: 'a', attempt: 1 })

    host.finish(`${launch.id}-1`, sessionName(launch.id, 1, 3, 'Graph'), 'succeeded')
    await runtime.flushPending()
    expect(host.queuedTaskIds()).toEqual([`${launch.id}-2`])
    expect(host.state.queue.items.at(-1)?.flow).toMatchObject({ specId: 'b', dependsOn: ['a'], attempt: 1, retries: 1 })

    host.finish(`${launch.id}-2`, sessionName(launch.id, 2, 3, 'Graph'), 'failed')
    await runtime.flushPending()
    expect(host.queuedTaskIds()).toEqual([`${launch.id}-2`])
    expect(host.state.queue.items.at(-1)?.flow).toMatchObject({ specId: 'b', attempt: 2 })
    expect(host.notifications.some((message) => message.includes('retrying (attempt 2)'))).toBe(true)

    host.finish(`${launch.id}-2`, sessionName(launch.id, 2, 3, 'Graph'), 'failed')
    await runtime.flushPending()
    expect(host.queuedTaskIds()).toEqual([])
    const run = runtime.getSnapshot().runs[0]!
    expect(run.tasks.map((task) => [task.specId, task.status, task.attempt])).toEqual([['a', 'completed', 1], ['b', 'failed', 2], ['c', 'blocked', 0]])
  })

  it('creates a worktree lane for lane tasks and records merge state', async () => {
    const host = new GraphHost()
    const lanes = fakeLanes()
    let sequence = 0
    const runtime = new FlowRuntime(host, { path: false, now: () => 1_000, createId: (prefix) => `${prefix}-L${++sequence}`, lanes })
    const launch = runtime.launch({ title: 'Lane', prompts: [], mode: 'sequential', workspacePath: host.state.workspacePath, tasks: [{ id: 'iso', prompt: 'Isolated work', lane: 'worktree' }] })
    await runtime.flushPending()
    expect(lanes.created).toEqual([`${launch.id}-1`])
    const prompt = host.state.queue.items.at(-1)!
    expect(prompt.flow).toMatchObject({ lane: 'worktree', lanePath: `/lanes/${launch.id}-1` })
    expect(prompt.text).toContain(`[Checkout lane: /lanes/${launch.id}-1]`)
    expect(prompt.text.endsWith('Isolated work')).toBe(true)
    expect(runtime.getSnapshot().runs[0]!.tasks[0]).toMatchObject({ laneId: `${launch.id}-1`, laneBranch: `heddlework/${launch.id}-1` })

    expect(await runtime.mergeLane(`${launch.id}-1`)).toEqual({ merged: true })
    expect(runtime.getSnapshot().runs[0]!.tasks[0]!.laneMerged).toBe(true)
    await runtime.removeLane(`${launch.id}-1`)
    expect(lanes.removed).toEqual([`${launch.id}-1`])
  })
})
