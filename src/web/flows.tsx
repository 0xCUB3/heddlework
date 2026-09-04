import { projectFlowRuns } from '../flows/projection.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import type { WorkbenchState } from '../workbench/state.ts'

export function Flows({ state }: { state: WorkbenchSnapshot }) {
  const runs = projectFlowRuns(state as WorkbenchState)
  if (runs.length === 0) return <p className="web-meta">No flow runs</p>
  return (
    <div className="web-flows">
      {runs.map((run) => (
        <section key={run.id} className="web-card">
          <h3>{run.title}</h3>
          <ul className="web-list">
            {run.tasks.map((task) => (
              <li key={task.id}>
                <span className={`web-pill web-pill-${task.status}`}>{task.status}</span>
                {task.title}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}
