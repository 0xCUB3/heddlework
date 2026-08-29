import { describe, expect, it } from 'bun:test'
import { projectFlowFabricGraph } from '../src/flows/fabric-projection.ts'
import type { PiMessage } from '../src/pi/types.ts'
import type { ToolRun } from '../src/workbench/state.ts'

const task = { id: 'HW-PAR-1', runId: 'HW-PAR', mode: 'parallel' as const, status: 'running' as const }

describe('Flow Fabric graph projection', () => {
  it('projects recursive live agent previews with parent edges, current tools, and a running join', () => {
    const messages: PiMessage[] = [{
      role: 'assistant',
      content: [{ type: 'toolCall', id: 'fabric-1', name: 'fabric_exec', arguments: { display: { name: 'HW-PAR-1' }, code: 'workflow.parallel([])' } }],
    }]
    const liveTools: ToolRun[] = [{
      id: 'fabric-1',
      name: 'fabric_exec',
      args: { display: { name: 'HW-PAR-1' } },
      status: 'running',
      isError: false,
      details: {
        audits: [
          {
            ref: 'agents.run',
            provider: 'agents',
            tool: 'run',
            args: { name: 'HW-PAR-1/B1' },
            preview: {
              kind: 'fabric-agent-tools',
              id: 'agent-parent',
              name: 'HW-PAR-1/B1',
              status: 'running',
              runner: 'pi',
              tools: [{ id: 'read-1', kind: 'tool', label: 'read', toolName: 'read', status: 'running', args: { path: 'src/main.tsx' } }],
              agents: [{ id: 'agent-child', name: 'HW-PAR-1/B1.1', status: 'completed', runner: 'pi', tools: [] }],
              agentsTruncated: true,
            },
          },
          {
            ref: 'agents.run',
            provider: 'agents',
            tool: 'run',
            args: { name: 'HW-PAR-1/B2' },
            preview: { kind: 'fabric-agent-tools', id: 'agent-sibling', name: 'HW-PAR-1/B2', status: 'running', runner: 'pi', currentTool: 'bash bun test', tools: [] },
          },
        ],
      },
    }]

    const graph = projectFlowFabricGraph(task, messages, liveTools)
    expect(graph.branches.map(({ id, parentId, depth, status }) => ({ id, parentId, depth, status }))).toEqual([
      { id: 'agent-parent', parentId: undefined, depth: 0, status: 'running' },
      { id: 'agent-child', parentId: 'agent-parent', depth: 1, status: 'succeeded' },
      { id: 'agent-sibling', parentId: undefined, depth: 0, status: 'running' },
    ])
    expect(graph.branches[0]?.currentTool).toBe('read src/main.tsx')
    expect(graph.branches[2]?.currentTool).toBe('bash bun test')
    expect(graph.join).toEqual({ status: 'running', settled: 1, total: 3, detail: '1/3 branches settled' })
    expect(graph.truncated).toBe(true)
  })

  it('replays completed branch previews and the join from persisted tool results', () => {
    const messages: PiMessage[] = [
      { role: 'assistant', content: [{ type: 'toolCall', id: 'fabric-done', name: 'fabric_exec', arguments: { display: { name: 'HW-PAR-1' } } }] },
      {
        role: 'toolResult',
        toolCallId: 'fabric-done',
        toolName: 'fabric_exec',
        content: 'done',
        isError: false,
        details: {
          audits: [
            { ref: 'agents.run', provider: 'agents', tool: 'run', success: true, preview: { kind: 'fabric-agent-tools', id: 'agent-a', name: 'HW-PAR-1/B1', status: 'completed', tools: [] } },
            { ref: 'agents.run', provider: 'agents', tool: 'run', success: true, preview: { kind: 'fabric-agent-tools', id: 'agent-b', name: 'HW-PAR-1/B2', status: 'completed', tools: [] } },
          ],
        },
      },
    ]
    expect(projectFlowFabricGraph({ ...task, status: 'succeeded' }, messages)).toMatchObject({
      branches: [{ id: 'agent-a', status: 'succeeded' }, { id: 'agent-b', status: 'succeeded' }],
      join: { status: 'succeeded', settled: 2, total: 2, detail: '2 branches joined' },
    })
  })

  it('projects participant truth for an ordinary observed Pi session', () => {
    const liveTools: ToolRun[] = [{
      id: 'fabric-observed',
      name: 'fabric_exec',
      args: { code: 'workflow.agent()' },
      status: 'running',
      isError: false,
      details: { audits: [{ ref: 'agents.run', provider: 'agents', preview: { kind: 'fabric-agent-tools', id: 'observed-agent', name: 'reviewer', status: 'running', tools: [] } }] },
    }]
    expect(projectFlowFabricGraph({ ...task, mode: 'observed' }, [], liveTools)).toMatchObject({
      branches: [{ id: 'observed-agent', name: 'reviewer', status: 'running' }],
      join: { status: 'running', settled: 0, total: 1 },
    })
  })
})
