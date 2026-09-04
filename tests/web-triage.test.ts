import { describe, expect, it } from 'bun:test'
import { compileFlowQueue } from '../src/flows/compiler.ts'
import { projectFlowRuns, terminalFlowTasks } from '../src/flows/projection.ts'
import type { FlowLaunch } from '../src/flows/types.ts'
import { projectTriageItems, snoozeUntil } from '../src/web/triage.ts'
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

describe('web triage projection', () => {
  it('matches desktop terminalFlowTasks for a fixture state', () => {
    const state = createInitialState('/tmp/project')
    state.queue = {
      ...state.queue,
      items: compileFlowQueue(launch).map((row, index) => ({
        id: `queue-${index}`,
        text: row.text,
        images: [],
        createdAt: 100 + index,
        ...(row.lane ? { lane: row.lane } : {}),
        ...(row.flow ? { flow: row.flow } : {}),
      })),
    }
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
    expect(projectTriageItems(state, 100).map((task) => task.id)).toEqual(terminalFlowTasks(projectFlowRuns(state, 100)).map((task) => task.id))
    expect(projectTriageItems(state, 100).map((task) => task.id)).toEqual(['HW-DONE-1', 'PI-ORDINARY'])
  })

  it('computes snooze presets from a fixed clock', () => {
    const now = Date.parse('2026-09-04T15:00:00-07:00')
    expect(snoozeUntil('hour', now) - now).toBe(60 * 60 * 1000)
    expect(new Date(snoozeUntil('tonight', now)).getHours()).toBe(21)
    expect(new Date(snoozeUntil('tomorrow', now)).getHours()).toBe(9)
  })
})
