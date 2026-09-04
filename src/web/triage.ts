import { projectFlowRuns, terminalFlowTasks, type FlowTaskProjection } from '../flows/projection.ts'
import type { WorkbenchState } from '../workbench/state.ts'

export function projectTriageItems(state: WorkbenchState, now = Date.now()): FlowTaskProjection[] {
  return terminalFlowTasks(projectFlowRuns(state, now))
}

export function snoozeUntil(preset: 'hour' | 'tonight' | 'tomorrow', now = Date.now()): number {
  if (preset === 'hour') return now + 60 * 60 * 1000
  const date = new Date(now)
  if (preset === 'tonight') {
    date.setHours(21, 0, 0, 0)
    if (date.getTime() <= now) date.setDate(date.getDate() + 1)
    return date.getTime()
  }
  date.setDate(date.getDate() + 1)
  date.setHours(9, 0, 0, 0)
  return date.getTime()
}
