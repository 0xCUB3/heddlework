import { queueItemsInDeliveryOrder } from '../workbench/queue.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'

export function Queue({ state }: { state: WorkbenchSnapshot }) {
  const items = queueItemsInDeliveryOrder(state.queue.items)
  const client = workspaceClient()
  if (items.length === 0) return <p className="web-meta">Queue is empty</p>
  return (
    <ul className="web-list">
      {items.map((item, index) => (
        <li key={item.id} className="web-card">
          <textarea defaultValue={item.text} onBlur={(event) => { void client.send({ type: 'updateQueuedInput', id: item.id, text: event.target.value }) }} />
          <div className="web-composer-row">
            <span className="web-meta">{item.lane ?? 'steer'}{item.paused ? ' · paused' : ''}</span>
            <button type="button" onClick={() => void client.send({ type: 'toggleQueuedInputPause', id: item.id })}>Hold</button>
            <button type="button" onClick={() => void client.send({ type: 'steerQueuedInput', id: item.id })}>Steer</button>
            <button type="button" onClick={() => void client.send({ type: 'moveQueuedInputToLane', id: item.id, lane: item.lane === 'followUp' ? 'steer' : 'followUp' })}>Lane</button>
            {index > 0 ? <button type="button" onClick={() => void client.send({ type: 'moveQueuedInput', id: item.id, targetIndex: index - 1 })}>Up</button> : null}
            <button type="button" onClick={() => void client.send({ type: 'removeQueuedInput', id: item.id })}>Remove</button>
          </div>
        </li>
      ))}
      <li className="web-composer-row">
        {state.queue.paused
          ? <button type="button" onClick={() => void client.send({ type: 'resumeQueue' })}>Resume</button>
          : <button type="button" onClick={() => void client.send({ type: 'pause' })}>Pause</button>}
      </li>
    </ul>
  )
}
