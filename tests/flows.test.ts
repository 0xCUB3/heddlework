import { describe, expect, it } from 'bun:test'
import { compileFlowQueue, parallelFlowPrompt } from '../src/flows/compiler.ts'
import { priorityForSessionDuration, projectFlowRuns, terminalFlowTasks } from '../src/flows/projection.ts'
import { formatFlowSessionName, nextScheduleRun, parseFlowSessionName, type FlowLaunch } from '../src/flows/types.ts'
import { createInitialState } from '../src/workbench/state.ts'

const launch: FlowLaunch = {
  id: 'HW-FLOW1',
  title: 'Release train',
  prompts: ['Prepare the release', 'Verify the release'],
  mode: 'sequential',
  model: 'provider/model',
  workspacePath: '/tmp/project',
  source: 'manual',
  createdAt: 100,
}

describe('Flow queue compilation', () => {
  it('compiles each sequential task into fresh-session queue primitives with stable correlation', () => {
    const rows = compileFlowQueue(launch)
    expect(rows.map((row) => row.text)).toEqual([
      '/new',
      '/model provider/model',
      '/name Flow HW-FLOW1/1:2 · Release train · Step 1',
      'Prepare the release',
      '/new',
      '/model provider/model',
      '/name Flow HW-FLOW1/2:2 · Release train · Step 2',
      'Verify the release',
    ])
    expect(rows.map((row) => row.flow?.phase)).toEqual(['new-session', 'set-model', 'set-name', 'prompt', 'new-session', 'set-model', 'set-name', 'prompt'])
    expect(new Set(rows.map((row) => row.flow?.runId))).toEqual(new Set(['HW-FLOW1']))
    expect(rows[4]?.flow).toMatchObject({ taskId: 'HW-FLOW1-2', taskIndex: 1, taskCount: 2 })
  })

  it('wraps one parallel task in an explicit pi-fabric orchestration prompt', () => {
    const parallel = { ...launch, id: 'HW-PAR1', prompts: ['Inspect API and UI'], mode: 'parallel' as const }
    const prompt = parallelFlowPrompt(parallel, parallel.prompts[0]!)
    expect(prompt).toContain('[Flow HW-PAR1]')
    expect(prompt).toContain('fabric_exec')
    expect(prompt).toContain('workflow.parallel')
    expect(prompt).toContain('[Flow Task HW-PAR1-1]')
    expect(prompt).toContain('display.name exactly to "HW-PAR1-1"')
    expect(prompt).toContain('HW-PAR1-1/B1')
    expect(prompt).toContain('() => workflow.agent')
    expect(prompt).toContain('Wait for every branch to settle, join their results')
    expect(prompt).toContain('Task:\nInspect API and UI')
    expect(compileFlowQueue(parallel).at(-1)?.text).toBe(prompt)
  })

  it('round-trips manual and scheduled session identities without model context markers', () => {
    const manualName = formatFlowSessionName(launch, 1)
    expect(parseFlowSessionName(manualName)).toEqual({ runId: 'HW-FLOW1', taskId: 'HW-FLOW1-2', title: 'Release train · Step 2', source: 'manual', taskIndex: 1, taskCount: 2 })
    const scheduled = { ...launch, id: 'HW-RUN1', prompts: ['Nightly check'], source: 'scheduled' as const, scheduleId: 'SCH-NIGHT' }
    expect(parseFlowSessionName(formatFlowSessionName(scheduled, 0))).toMatchObject({ runId: 'HW-RUN1', taskId: 'HW-RUN1-1', source: 'scheduled', scheduleId: 'SCH-NIGHT' })
  })
})

describe('Flow projection', () => {
  it('merges owned queue rows and terminal Pi sessions without persisted task status', () => {
    const state = createInitialState('/tmp/project')
    const rows = compileFlowQueue(launch).map((row, index) => ({
      id: `queue-${index}`,
      text: row.text,
      images: [],
      createdAt: 100 + index,
      ...(row.lane ? { lane: row.lane } : {}),
      ...(row.flow ? { flow: row.flow } : {}),
    }))
    state.queue = { ...state.queue, items: rows }
    state.sessions = [
      {
        id: 'session-one',
        path: '/tmp/session-one.jsonl',
        cwd: '/tmp/project',
        title: 'Flow HW-DONE/1:1 · Completed audit',
        name: 'Flow HW-DONE/1:1 · Completed audit',
        firstMessage: 'Audit the release',
        messageCount: 2,
        createdAt: 10,
        modifiedAt: 20,
        lastAssistantText: 'Everything passed.',
        lastAssistantStopReason: 'stop',
      },
      {
        id: 'ordinary',
        path: '/tmp/ordinary.jsonl',
        cwd: '/tmp/project',
        title: 'Observed work',
        firstMessage: 'Investigate an issue',
        messageCount: 2,
        createdAt: 5,
        modifiedAt: 15,
        lastAssistantText: 'The issue is isolated.',
        lastAssistantStopReason: 'error',
      },
    ]

    const runs = projectFlowRuns(state, 100)
    expect(runs.find((run) => run.id === 'HW-FLOW1')?.tasks.map((task) => task.status)).toEqual(['queued', 'queued'])
    expect(runs.find((run) => run.id === 'HW-DONE')?.tasks[0]).toMatchObject({ status: 'succeeded', result: 'Everything passed.' })
    expect(runs.find((run) => run.id === 'observed:ordinary')?.tasks[0]).toMatchObject({ source: 'observed', status: 'failed' })
    expect(terminalFlowTasks(runs).map((task) => task.id)).toEqual(['HW-DONE-1', 'PI-ORDINARY'])
  })

  it('projects ordinary queue lanes and control barriers without authored Flow metadata', () => {
    const state = createInitialState('/tmp/project')
    state.queue = {
      ...state.queue,
      items: [
        { id: 'follow-new', text: '/new', images: [], createdAt: 10, lane: 'followUp' },
        { id: 'steer-one', text: 'Clarify the active run', images: [], createdAt: 11, lane: 'steer', paused: true },
        { id: 'follow-await', text: '/fabric await reviewer', images: [], createdAt: 12, lane: 'followUp' },
        { id: 'follow-prompt', text: 'Implement after review', images: [], createdAt: 13, lane: 'followUp' },
      ],
    }

    const runs = projectFlowRuns(state, 20)
    expect(runs.find((run) => run.id === 'queue:steer')).toMatchObject({ source: 'queue', title: 'Steering queue' })
    expect(runs.find((run) => run.id === 'queue:steer')?.tasks).toEqual([expect.objectContaining({ id: 'steer-one', mode: 'queue', queueLane: 'steer', status: 'paused' })])
    expect(runs.find((run) => run.id === 'queue:followUp')?.tasks.map((task) => ({ id: task.id, title: task.title, status: task.status, index: task.taskIndex }))).toEqual([
      { id: 'follow-new', title: 'New session', status: 'queued', index: 0 },
      { id: 'follow-await', title: 'Wait for reviewer', status: 'queued', index: 1 },
      { id: 'follow-prompt', title: 'Implement after review', status: 'queued', index: 2 },
    ])
  })

  it('derives settled, unread, labels, and priority while honoring presentation overrides', () => {
    const now = 2_000_000_000_000
    const modifiedAt = now - 8 * 24 * 60 * 60 * 1_000
    const path = '/tmp/metadata.jsonl'
    const state = createInitialState('/tmp/project')
    state.sessions = [{
      id: 'metadata', path, cwd: '/tmp/project', title: 'Metadata projection', firstMessage: 'Inspect metadata',
      messageCount: 2, createdAt: modifiedAt - 3 * 60 * 60 * 1_000, modifiedAt, lastAssistantText: 'Done', lastAssistantStopReason: 'stop',
    }]
    state.threadLifecycle[path] = { priority: 2, labels: ['release'], readAt: modifiedAt - 1 }

    expect(projectFlowRuns(state, now)[0]?.tasks[0]).toMatchObject({ priority: 2, priorityOverridden: true, labels: ['release'], unread: true, settled: true })
    state.threadLifecycle[path] = { labels: ['release'], readAt: modifiedAt, unsettledAt: now }
    expect(projectFlowRuns(state, now)[0]?.tasks[0]).toMatchObject({ priority: 1, priorityOverridden: false, unread: false, settled: false })
    expect(priorityForSessionDuration(0, 4 * 60 * 1_000)).toBe(4)
    expect(priorityForSessionDuration(0, 10 * 60 * 1_000)).toBe(3)
    expect(priorityForSessionDuration(0, 60 * 60 * 1_000)).toBe(2)
    expect(priorityForSessionDuration(0, 3 * 60 * 60 * 1_000)).toBe(1)
  })

  it('keeps parent-linked Pi sessions in one causal rail after queued handoffs finish', () => {
    const state = createInitialState('/tmp/project')
    state.sessions = [
      { id: 'child-two', path: '/tmp/child-two.jsonl', cwd: '/tmp/project', title: 'Verify the result', firstMessage: 'Verify', messageCount: 2, createdAt: 30, modifiedAt: 40, parentSession: '/tmp/child-one.jsonl', lastAssistantText: 'Verified', lastAssistantStopReason: 'stop' },
      { id: 'unrelated', path: '/tmp/unrelated.jsonl', cwd: '/tmp/project', title: 'Independent work', firstMessage: 'Independent', messageCount: 2, createdAt: 15, modifiedAt: 25, lastAssistantText: 'Done', lastAssistantStopReason: 'stop' },
      { id: 'child-one', path: '/tmp/child-one.jsonl', cwd: '/tmp/project', title: 'Implement the change', firstMessage: 'Implement', messageCount: 2, createdAt: 20, modifiedAt: 30, parentSession: '/tmp/root.jsonl', lastAssistantText: 'Implemented', lastAssistantStopReason: 'stop' },
      { id: 'root', path: '/tmp/root.jsonl', cwd: '/tmp/project', title: 'Plan the change', firstMessage: 'Plan', messageCount: 2, createdAt: 10, modifiedAt: 20, lastAssistantText: 'Planned', lastAssistantStopReason: 'stop' },
    ]

    const runs = projectFlowRuns(state, 50)
    expect(runs.find((run) => run.id === 'observed-chain:root')).toMatchObject({
      source: 'observed',
      title: 'Plan the change',
      tasks: [
        { id: 'PI-ROOT', taskIndex: 0, taskCount: 3 },
        { id: 'PI-CHILD-ON', taskIndex: 1, taskCount: 3 },
        { id: 'PI-CHILD-TW', taskIndex: 2, taskCount: 3 },
      ],
    })
    expect(runs.find((run) => run.id === 'observed:unrelated')?.tasks[0]).toMatchObject({ taskIndex: 0, taskCount: 1 })
  })

  it('projects an unsaved active Pi session as observed work', () => {
    const state = createInitialState('/tmp/project')
    state.session = { model: null, thinkingLevel: 'off', isStreaming: true, sessionId: 'live-session' }
    state.messages = [{ role: 'user', content: 'Investigate live state', timestamp: 100 }]
    expect(projectFlowRuns(state)[0]?.tasks[0]).toMatchObject({ id: 'PI-LIVE-SES', title: 'Investigate live state', source: 'observed', status: 'running' })
  })
})

describe('Flow schedules', () => {
  it('advances interval and daily schedules strictly after the supplied instant', () => {
    expect(nextScheduleRun({ kind: 'interval', everyMinutes: 15, anchorAt: 1_000 }, 1_000)).toBe(901_000)
    const noon = new Date(2026, 0, 1, 12, 0, 0, 0).getTime()
    const next = nextScheduleRun({ kind: 'daily', hour: 9, minute: 30 }, noon)
    expect(new Date(next!).getDate()).toBe(new Date(noon).getDate() + 1)
    expect(new Date(next!).getHours()).toBe(9)
    expect(new Date(next!).getMinutes()).toBe(30)
  })
})
