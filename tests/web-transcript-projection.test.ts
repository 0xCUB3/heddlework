import { describe, expect, it } from 'bun:test'
import { groupWorkItems, projectTranscriptRows } from '../src/ui/transcript-projection.ts'
import { projectWorkspaceRows, workspaceRowKinds } from '../src/web/rows.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { buildTimeline } from '../src/workbench/timeline.ts'

describe('web transcript row projection', () => {
  it('matches the GPUIX row kinds for a fixture transcript', () => {
    const state = {
      ...createInitialState('/tmp/heddlework-web-rows'),
      messages: [
        { role: 'user' as const, content: 'Inspect the project', timestamp: 1 },
        {
          role: 'assistant' as const,
          content: [
            { type: 'toolCall', id: 'one', name: 'read', arguments: { path: 'a.ts' } },
            { type: 'text', text: 'Here is the answer.' },
          ],
          timestamp: 2,
        },
      ],
    }
    const emptyTraces = new Set<string>()
    const emptyLimits = new Map<string, number>()
    const gpuix = projectTranscriptRows(groupWorkItems(buildTimeline(state.messages, state.liveAssistant, state.liveTools, state.forkMessages), state.session.isStreaming), emptyTraces, emptyLimits)
    const web = projectWorkspaceRows(state)
    expect(workspaceRowKinds(web)).toEqual(gpuix.map((row) => row.kind))
    expect(workspaceRowKinds(web)).toContain('trace-header')
    expect(workspaceRowKinds(web)).toContain('timeline-item')
  })
})
