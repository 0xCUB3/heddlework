import { projectFlowRuns } from '../flows/projection.ts'
import type { FlowRunRecord } from '../flows/types.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { workspaceClient } from './store.ts'

export function Flows({ state, runs: records = [] }: { state: WorkbenchSnapshot; runs?: readonly FlowRunRecord[] | undefined }) {
  const runs = projectFlowRuns(state as WorkbenchState)
  if (runs.length === 0) return <p className="web-meta">No flow runs</p>
  return (
    <div className="web-flows">
      {runs.map((run) => (
        <section key={run.id} className="web-card">
          <h3>{run.title}</h3>
          <ul className="web-list">
            {run.tasks.map((task) => {
              const record = records.flatMap((entry) => entry.tasks).find((entry) => entry.taskId === task.id)
              const spec = records.find((entry) => entry.launch.id === task.runId)?.launch.tasks?.[task.taskIndex]
              return (
                <li key={task.id}>
                  <span className={`web-pill web-pill-${task.status}`}>{task.status}</span>
                  {task.title}
                  {spec?.dependsOn?.length ? <span className="web-meta"> · after {spec.dependsOn.join(', ')}</span> : null}
                  {record && record.attempt > 1 ? <span className="web-meta"> · attempt {record.attempt}</span> : null}
                  {record?.lanePath ? (
                    <span className="web-meta"> · lane {record.laneMerged ? 'merged' : record.laneRemoved ? 'removed' : record.laneBranch}
                      {!record.laneMerged && !record.laneRemoved && task.status === 'succeeded' ? <button type="button" onClick={() => void workspaceClient().sendAndReport({ type: 'mergeLane', laneId: record.laneId! })}>Merge lane</button> : null}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}
