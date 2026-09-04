import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'

export function Settings({ state, workspacePath, onDisconnect }: { state: WorkbenchSnapshot; workspacePath: string; onDisconnect: () => void }) {
  const client = workspaceClient()
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
      <p className="web-meta">Workspace {workspacePath}</p>
      <p className="web-meta">Connection {state.connection} · {state.connectionMessage}</p>
      <button type="button" onClick={onDisconnect}>Disconnect</button>
    </div>
  )
}
