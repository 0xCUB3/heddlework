import { useState } from 'react'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { requestWorkspaceNotifications } from './notifications.ts'
import { workspaceClient } from './store.ts'

export function Settings({ state, workspacePath, onDisconnect }: { state: WorkbenchSnapshot; workspacePath: string; onDisconnect: () => void }) {
  const client = workspaceClient()
  const [notifyEnabled, setNotifyEnabled] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted')
  return (
    <div className="web-settings">
      <label>
        Model
        <select
          value={state.session.model ? `${state.session.model.provider}/${state.session.model.id}` : ''}
          onChange={(event) => {
            const [provider, id] = event.target.value.split('/')
            if (provider && id) void client.send({ type: 'setModel', provider, id })
          }}
        >
          {state.models.map((model) => (
            <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? `${model.provider}/${model.id}`}</option>
          ))}
        </select>
      </label>
      <label>
        Thinking
        <select value={state.session.thinkingLevel} onChange={(event) => void client.send({ type: 'setThinkingLevel', level: event.target.value as WorkbenchSnapshot['session']['thinkingLevel'] })}>
          {state.thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}
        </select>
      </label>
      <label>
        <input
          type="checkbox"
          checked={notifyEnabled}
          onChange={() => {
            void requestWorkspaceNotifications().then(setNotifyEnabled)
          }}
        />
        Notify when a turn finishes or an approval appears
      </label>
      <p className="web-meta">Workspace {workspacePath}</p>
      <p className="web-meta">Connection {state.connection} · {state.connectionMessage}</p>
      <p className="web-meta">Install this companion from the browser share sheet or Add to Home Screen. LAN hosts need HEDDLEWORK_HOST_BIND=0.0.0.0.</p>
      <button type="button" onClick={onDisconnect}>Disconnect</button>
    </div>
  )
}
