import { describe, expect, it } from 'bun:test'
import { projectFlowActivity, type FlowActivitySubject } from '../src/flows/activity.ts'
import { buildTimeline } from '../src/workbench/timeline.ts'
import type { PiMessage } from '../src/pi/types.ts'

const subject: FlowActivitySubject = {
  id: 'PI-ACTIVITY',
  prompt: 'Inspect the repository',
  source: 'observed',
  status: 'succeeded',
  createdAt: 1_000,
  updatedAt: 9_000,
}

describe('Flow activity projection', () => {
  it('batches each session turn into prompt, context, tool, and response activity', () => {
    const messages: PiMessage[] = [
      { role: 'user', content: 'Inspect the repository', timestamp: 1_100 },
      { role: 'custom', display: true, customType: 'fabric-context', content: 'Workspace context', timestamp: 1_200 },
      {
        role: 'assistant',
        timestamp: 2_000,
        content: [
          { type: 'thinking', thinking: 'Inspecting files' },
          { type: 'toolCall', id: 'read-1', name: 'read', arguments: { path: 'a.ts' } },
          { type: 'toolCall', id: 'read-2', name: 'read', arguments: { path: 'b.ts' } },
          { type: 'text', text: 'The first pass is complete.' },
        ],
      },
      { role: 'toolResult', toolCallId: 'read-1', toolName: 'read', content: 'a', timestamp: 2_100 },
      { role: 'toolResult', toolCallId: 'read-2', toolName: 'read', content: 'b', timestamp: 2_200 },
      { role: 'user', content: 'Apply the correction', timestamp: 3_000 },
      { role: 'assistant', content: [{ type: 'text', text: 'The correction is applied.' }], timestamp: 4_000 },
    ]

    const activity = projectFlowActivity(subject, buildTimeline(messages, undefined, []))

    expect(activity.map((entry) => entry.title)).toEqual([
      'Session started',
      'Prompted Pi',
      'Applied 1 context update',
      'Ran 2 tool calls',
      'Produced a response',
      'Sent a follow-up',
      'Produced a response',
      'Session completed',
    ])
    expect(activity.find((entry) => entry.kind === 'tools')?.detail).toBe('read ×2')
    expect(activity.find((entry) => entry.kind === 'response')?.detail).toBe('The first pass is complete.')
  })

  it('projects useful lifecycle activity when no transcript page is available', () => {
    expect(projectFlowActivity({ ...subject, status: 'failed', stopReason: 'error' }, []).map((entry) => entry.title)).toEqual([
      'Session started',
      'Prompted Pi',
      'Session failed',
    ])
  })
})
