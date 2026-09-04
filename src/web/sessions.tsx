import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'

export function Sessions({ state }: { state: WorkbenchSnapshot }) {
  const client = workspaceClient()
  return (
    <nav className="web-sessions">
      <div className="web-composer-row">
        <button type="button" onClick={() => void client.send({ type: 'newSession' })}>New</button>
        <button type="button" onClick={() => void client.send({ type: 'refreshSessions' })}>Refresh</button>
      </div>
      <ul className="web-list">
        {state.sessions.map((session) => (
          <li key={session.path}>
            <button
              type="button"
              className={session.path === state.session.sessionFile ? 'web-session-active' : 'web-session'}
              onClick={() => void client.send({ type: 'switchSession', path: session.path })}
            >
              <strong>{session.title || session.name || session.id}</strong>
              <span className="web-meta">{session.firstMessage}</span>
            </button>
          </li>
        ))}
      </ul>
      {state.sessionsHasMore ? <button type="button" onClick={() => void client.send({ type: 'loadMoreSessions' })}>Load more</button> : null}
    </nav>
  )
}
