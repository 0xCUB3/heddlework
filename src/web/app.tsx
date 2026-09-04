import { useState } from 'react'
import { Composer } from './composer.tsx'
import { Dialogs } from './dialogs.tsx'
import { Diff } from './diff.tsx'
import { Flows } from './flows.tsx'
import { Queue } from './queue.tsx'
import { Sessions } from './sessions.tsx'
import { Settings } from './settings.tsx'
import { Transcript } from './transcript.tsx'
import { useWorkspace, workspaceClient } from './store.ts'

type Drawer = 'diff' | 'flows' | 'settings' | 'queue' | undefined

export function WebApp() {
  const view = useWorkspace()
  const [drawer, setDrawer] = useState<Drawer>(undefined)
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const state = view.state

  if (view.status !== 'open' || !state) {
    return (
      <main className="web-shell web-connect">
        <h1>Heddlework</h1>
        <p className="web-meta">{view.lastError ?? (view.status === 'connecting' ? 'Connecting…' : 'Not connected. Open a host connect link.')}</p>
      </main>
    )
  }

  return (
    <div className="web-shell">
      <aside className={sessionsOpen ? 'web-rail' : 'web-rail web-rail-collapsed'}>
        <button type="button" className="web-rail-toggle" onClick={() => setSessionsOpen((open) => !open)}>{sessionsOpen ? 'Sessions' : '≡'}</button>
        {sessionsOpen ? <Sessions state={state} /> : null}
      </aside>
      <main className="web-main">
        <header className="web-toolbar">
          <strong>{state.session.sessionName || view.workspacePath}</strong>
          <span className="web-meta">{state.activity}</span>
          <button type="button" onClick={() => setDrawer(drawer === 'queue' ? undefined : 'queue')}>Queue</button>
          <button type="button" onClick={() => setDrawer(drawer === 'diff' ? undefined : 'diff')}>Diff</button>
          <button type="button" onClick={() => setDrawer(drawer === 'flows' ? undefined : 'flows')}>Flows</button>
          <button type="button" onClick={() => setDrawer(drawer === 'settings' ? undefined : 'settings')}>Settings</button>
        </header>
        <Transcript state={state} />
        <Dialogs state={state} />
        <Composer state={state} />
      </main>
      {drawer ? (
        <aside className="web-drawer">
          {drawer === 'queue' ? <Queue state={state} /> : null}
          {drawer === 'diff' ? <Diff state={state} /> : null}
          {drawer === 'flows' ? <Flows state={state} /> : null}
          {drawer === 'settings' ? <Settings state={state} workspacePath={view.workspacePath} onDisconnect={() => workspaceClient().disconnect()} /> : null}
        </aside>
      ) : null}
    </div>
  )
}
