import type { WorkbenchSnapshot } from '../protocol/index.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { workspaceClient } from './store.ts'
import { projectTriageItems, snoozeUntil } from './triage.ts'

export function Triage({ state }: { state: WorkbenchSnapshot }) {
  const items = projectTriageItems(state as WorkbenchState)
  const client = workspaceClient()
  if (items.length === 0) return <p className="web-meta">No terminal tasks</p>
  return (
    <div className="web-triage">
      {items.map((task) => {
        const path = task.session?.path ?? task.metadataKey
        return (
          <section key={task.id} className="web-card">
            <p>
              <span className={`web-pill web-pill-${task.status}`}>{task.status}</span>
              {task.title}
            </p>
            {task.result ? <p className="web-meta">{task.result}</p> : null}
            <div className="web-composer-row">
              <button type="button" onClick={() => void client.send({ type: 'settleThread', path })}>Settle</button>
              <button type="button" onClick={() => void client.send({ type: 'snoozeThread', path, snoozedUntil: snoozeUntil('hour') })}>1 hour</button>
              <button type="button" onClick={() => void client.send({ type: 'snoozeThread', path, snoozedUntil: snoozeUntil('tonight') })}>Tonight</button>
              <button type="button" onClick={() => void client.send({ type: 'snoozeThread', path, snoozedUntil: snoozeUntil('tomorrow') })}>Tomorrow</button>
              <button type="button" onClick={() => void client.send({ type: 'markThreadRead', path, updatedAt: Date.now() })}>Mark read</button>
            </div>
          </section>
        )
      })}
    </div>
  )
}
