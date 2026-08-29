import type { PiMessage } from '../pi/types.ts'
import type { ToolRun } from '../workbench/state.ts'
import type { FlowTaskProjection, FlowTaskStatus } from './projection.ts'

export type FabricBranchStatus = FlowTaskStatus | 'stopped'

export interface FabricBranchProjection {
  id: string
  name: string
  status: FabricBranchStatus
  depth: number
  parentId?: string | undefined
  runner?: string | undefined
  currentTool?: string | undefined
  detail?: string | undefined
}

export interface FabricJoinProjection {
  status: FabricBranchStatus
  settled: number
  total: number
  detail: string
}

export interface FlowFabricProjection {
  branches: FabricBranchProjection[]
  join: FabricJoinProjection | undefined
  truncated: boolean
}

interface FabricInvocation {
  id: string
  args: unknown
  details: unknown
  status: 'running' | 'complete'
  isError: boolean
}

export function projectFlowFabricGraph(
  task: Pick<FlowTaskProjection, 'id' | 'runId' | 'mode' | 'status'>,
  messages: readonly PiMessage[],
  liveTools: readonly ToolRun[] = [],
): FlowFabricProjection {
  const invocations = fabricInvocations(messages, liveTools)
  const branches = new Map<string, FabricBranchProjection>()
  const order: string[] = []
  let truncated = false

  const upsert = (branch: FabricBranchProjection) => {
    const previous = branches.get(branch.id)
    if (!previous) order.push(branch.id)
    branches.set(branch.id, previous ? mergeBranch(previous, branch) : branch)
  }

  for (const invocation of invocations) {
    const audits = auditRecords(invocation.details)
    for (const audit of audits) {
      const preview = recordOf(audit.preview)
      if (isAgentPreview(preview)) {
        truncated = flattenPreview(preview, undefined, 0, upsert) || truncated
        continue
      }
      if (!isAgentAudit(audit)) continue
      for (const candidate of agentResultRecords(audit.result)) {
        const id = stringOf(candidate.id) ?? stringOf(candidate.agentId) ?? stringOf(candidate.runId)
        if (!id) continue
        upsert({
          id,
          name: stringOf(candidate.name) ?? stringOf(recordOf(audit.args)?.name) ?? agentAuditName(audit),
          status: statusOf(candidate.status, audit.success === false ? 'failed' : invocation.status === 'complete' ? 'succeeded' : 'running'),
          depth: 0,
          ...(stringOf(candidate.runner) ? { runner: stringOf(candidate.runner) } : {}),
        })
      }
    }
  }

  const projected = order.flatMap((id) => branches.get(id) ?? [])
  if (projected.length === 0) return { branches: [], join: undefined, truncated }
  const failed = projected.some((branch) => branch.status === 'failed') || invocations.some((invocation) => invocation.isError)
  const stopped = !failed && projected.some((branch) => branch.status === 'stopped')
  const active = projected.some((branch) => branch.status === 'running' || branch.status === 'queued')
    || invocations.some((invocation) => invocation.status === 'running')
  const settled = projected.filter((branch) => branch.status === 'succeeded' || branch.status === 'failed' || branch.status === 'stopped').length
  const status: FabricBranchStatus = failed
    ? 'failed'
    : stopped
      ? 'stopped'
      : active
        ? 'running'
        : task.status === 'failed'
          ? 'failed'
          : 'succeeded'
  return {
    branches: projected,
    join: {
      status,
      settled,
      total: projected.length,
      detail: active ? `${settled}/${projected.length} branches settled` : `${projected.length} branches joined`,
    },
    truncated,
  }
}

function fabricInvocations(messages: readonly PiMessage[], liveTools: readonly ToolRun[]): FabricInvocation[] {
  const argsById = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === 'toolCall' && block.name === 'fabric_exec' && typeof block.id === 'string') argsById.set(block.id, block.arguments)
    }
  }
  const invocations: FabricInvocation[] = []
  const completedIds = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'toolResult' || message.toolName !== 'fabric_exec' || typeof message.toolCallId !== 'string') continue
    completedIds.add(message.toolCallId)
    invocations.push({
      id: message.toolCallId,
      args: argsById.get(message.toolCallId),
      details: message.details,
      status: 'complete',
      isError: message.isError === true,
    })
  }
  for (const tool of liveTools) {
    if (tool.name !== 'fabric_exec') continue
    const existing = invocations.find((invocation) => invocation.id === tool.id)
    if (existing) {
      if (tool.details !== undefined) existing.details = tool.details
      existing.isError = tool.isError
      existing.status = tool.status === 'complete' ? 'complete' : 'running'
      continue
    }
    if (completedIds.has(tool.id)) continue
    invocations.push({
      id: tool.id,
      args: tool.args ?? argsById.get(tool.id),
      details: tool.details,
      status: tool.status === 'complete' ? 'complete' : 'running',
      isError: tool.isError,
    })
  }
  return invocations
}

function auditRecords(details: unknown): Array<Record<string, unknown>> {
  const record = recordOf(details)
  if (!record) return []
  if (Array.isArray(record.audits)) return record.audits.flatMap((audit) => {
    const parsed = recordOf(audit)
    return parsed ? [parsed] : []
  })
  const trace = recordOf(record.trace)
  if (trace && Array.isArray(trace.calls)) return trace.calls.flatMap((audit) => {
    const parsed = recordOf(audit)
    return parsed ? [parsed] : []
  })
  return []
}

function flattenPreview(
  node: Record<string, unknown>,
  parentId: string | undefined,
  depth: number,
  upsert: (branch: FabricBranchProjection) => void,
): boolean {
  const id = stringOf(node.id)
  const name = stringOf(node.name)
  if (!id || !name) return false
  const currentTool = previewTool(node)
  const text = clipped(stringOf(node.text), 120)
  upsert({
    id,
    name,
    status: statusOf(node.status, 'running'),
    depth,
    ...(parentId ? { parentId } : {}),
    ...(stringOf(node.runner) ? { runner: stringOf(node.runner) } : {}),
    ...(currentTool ? { currentTool } : {}),
    ...(currentTool || text ? { detail: currentTool ?? text } : {}),
  })
  let truncated = node.agentsTruncated === true
  if (Array.isArray(node.agents)) {
    for (const child of node.agents) {
      const childRecord = recordOf(child)
      if (childRecord) truncated = flattenPreview(childRecord, id, depth + 1, upsert) || truncated
    }
  }
  return truncated
}

function previewTool(node: Record<string, unknown>): string | undefined {
  const direct = clipped(stringOf(node.currentTool), 80)
  if (direct) return direct
  if (!Array.isArray(node.tools)) return undefined
  const tools = node.tools.flatMap((tool) => {
    const parsed = recordOf(tool)
    return parsed ? [parsed] : []
  })
  const selected = [...tools].reverse().find((tool) => tool.status === 'running') ?? tools.at(-1)
  if (!selected) return undefined
  const name = stringOf(selected.toolName) ?? stringOf(selected.label)
  if (!name) return undefined
  const args = recordOf(selected.args)
  const target = args ? stringOf(args.path) ?? stringOf(args.pattern) ?? stringOf(args.command) : undefined
  return clipped(target ? `${name} ${target}` : name, 80)
}

function mergeBranch(previous: FabricBranchProjection, next: FabricBranchProjection): FabricBranchProjection {
  const preferNext = statusRank(next.status) >= statusRank(previous.status)
  return {
    ...(preferNext ? previous : next),
    ...(preferNext ? next : previous),
    depth: Math.min(previous.depth, next.depth),
    ...(next.parentId ?? previous.parentId ? { parentId: next.parentId ?? previous.parentId } : {}),
    ...(next.currentTool ?? previous.currentTool ? { currentTool: next.currentTool ?? previous.currentTool } : {}),
    ...(next.detail ?? previous.detail ? { detail: next.detail ?? previous.detail } : {}),
  }
}

function statusRank(status: FabricBranchStatus): number {
  if (status === 'failed' || status === 'stopped' || status === 'succeeded') return 3
  if (status === 'running') return 2
  return 1
}

function statusOf(value: unknown, fallback: FabricBranchStatus): FabricBranchStatus {
  if (typeof value !== 'string') return fallback
  const normalized = value.toLowerCase().replaceAll('_', '-')
  if (['completed', 'complete', 'succeeded', 'success', 'done', 'idle'].includes(normalized)) return 'succeeded'
  if (['failed', 'failure', 'error', 'timed-out', 'timeout'].includes(normalized)) return 'failed'
  if (['cancelled', 'canceled', 'aborted', 'stopped', 'killed'].includes(normalized)) return 'stopped'
  if (['queued', 'pending', 'spawning', 'created'].includes(normalized)) return 'queued'
  if (['running', 'active', 'working', 'streaming', 'waiting'].includes(normalized)) return 'running'
  return fallback
}

function isAgentPreview(value: Record<string, unknown> | undefined): value is Record<string, unknown> {
  return Boolean(value && value.kind === 'fabric-agent-tools' && typeof value.id === 'string' && typeof value.name === 'string' && Array.isArray(value.tools))
}

function isAgentAudit(audit: Record<string, unknown>): boolean {
  return audit.provider === 'agents'
    || (typeof audit.ref === 'string' && audit.ref.startsWith('agents.'))
    || (typeof audit.ref === 'string' && audit.ref.startsWith('workflow.agent'))
}

function agentAuditName(audit: Record<string, unknown>): string {
  const ref = stringOf(audit.ref) ?? stringOf(audit.tool) ?? 'agent'
  return ref.split('.').at(-1) ?? 'agent'
}

function agentResultRecords(value: unknown): Array<Record<string, unknown>> {
  const record = recordOf(value)
  if (record) {
    const nested = [record.result, record.results, record.agents].flatMap((candidate) => Array.isArray(candidate) ? candidate : candidate === undefined ? [] : [candidate])
    return [record, ...nested.flatMap(agentResultRecords)]
  }
  if (Array.isArray(value)) return value.flatMap(agentResultRecords)
  return []
}

function clipped(value: string | undefined, limit: number): string | undefined {
  if (!value) return undefined
  const compact = value.replace(/\s+/g, ' ').trim()
  if (!compact) return undefined
  return compact.length > limit ? `${compact.slice(0, Math.max(1, limit - 1))}…` : compact
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
