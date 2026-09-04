import type { FlowTaskSpec } from './types.ts'

export type FlowGraphTaskState = 'ready' | 'waiting' | 'blocked' | 'completed' | 'failed'

export interface FlowGraphReadiness {
  ready: FlowTaskSpec[]
  waiting: FlowTaskSpec[]
  blocked: FlowTaskSpec[]
}

// Splits the remaining tasks by whether every dependency has completed, is still pending, or has failed.
export function readyTasks(tasks: readonly FlowTaskSpec[], completed: ReadonlySet<string>, failed: ReadonlySet<string>): FlowGraphReadiness {
  const readiness: FlowGraphReadiness = { ready: [], waiting: [], blocked: [] }
  const blockedIds = new Set<string>()
  for (const task of topologicalOrder(tasks)) {
    if (completed.has(task.id) || failed.has(task.id)) continue
    const dependencies = task.dependsOn ?? []
    if (dependencies.some((id) => failed.has(id) || blockedIds.has(id))) {
      blockedIds.add(task.id)
      readiness.blocked.push(task)
      continue
    }
    if (dependencies.every((id) => completed.has(id))) readiness.ready.push(task)
    else readiness.waiting.push(task)
  }
  return readiness
}

export function taskGraphState(task: FlowTaskSpec, completed: ReadonlySet<string>, failed: ReadonlySet<string>, readiness = readyTasks([task], completed, failed)): FlowGraphTaskState {
  if (completed.has(task.id)) return 'completed'
  if (failed.has(task.id)) return 'failed'
  if (readiness.ready.some((candidate) => candidate.id === task.id)) return 'ready'
  if (readiness.blocked.some((candidate) => candidate.id === task.id)) return 'blocked'
  return 'waiting'
}

// Stable Kahn ordering: tasks keep their declared order among peers whose dependencies are satisfied.
export function topologicalOrder(tasks: readonly FlowTaskSpec[]): FlowTaskSpec[] {
  const remaining = [...tasks]
  const placed = new Set<string>()
  const ordered: FlowTaskSpec[] = []
  while (remaining.length > 0) {
    const index = remaining.findIndex((task) => (task.dependsOn ?? []).every((id) => placed.has(id) || !tasks.some((candidate) => candidate.id === id)))
    if (index === -1) throw new Error(`Flow task dependencies form a cycle among ${remaining.map((task) => task.id).join(', ')}`)
    const [task] = remaining.splice(index, 1)
    placed.add(task!.id)
    ordered.push(task!)
  }
  return ordered
}
