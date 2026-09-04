import { useEffect, useState } from 'react'
import { Composer } from './composer.tsx'
import { Dialogs } from './dialogs.tsx'
import { Diff } from './diff.tsx'
import { Flows } from './flows.tsx'
import { Queue } from './queue.tsx'
import { Sessions } from './sessions.tsx'
import { Settings } from './settings.tsx'
import { Transcript } from './transcript.tsx'
import { Triage } from './triage.tsx'
import { watchWorkspaceNotifications } from './notifications.ts'
import { useWorkspace, workspaceClient } from './store.ts'

type Tab = 'chat' | 'queue' | 'triage' | 'diff'
type Drawer = 'diff' | 'flows' | 'settings' | 'queue' | 'triage' | undefined

export function WebApp() {
  const view = useWorkspace()
  const [drawer, setDrawer] = useState<Drawer>(undefined)
  const [tab, setTab] = useState<Tab>('chat')
  const [sessionsOpen, setSessionsOpen] = useState(true)
  const [sheet, setSheet] = useState<'sessions' | undefined>(undefined)
  const state = view.state

  useEffect(() => watchWorkspaceNotifications(workspaceClient()), [])

  if (view.status !== 'open' || !state) {
    return (
      <main className="web-shell web-connect">
        <h1>Heddlework</h1>
        <p className="web-meta">{view.lastError ?? (view.status === 'connecting' ? 'Connecting…' : 'Not connected. Open a host connect link.')}</p>
      </main>
    )
  }

  const openDrawer = (next: Drawer): void => {
    setDrawer((current) => current === next ? undefined : next)
  }

  return (
    <div className="web-shell">
      <aside className={sessionsOpen ? 'web-rail' : 'web-rail web-rail-collapsed'}>
        <button type="button" className="web-rail-toggle" onClick={() => setSessionsOpen((open) => !open)}>{sessionsOpen ? 'Sessions' : '≡'}</button>
        {sessionsOpen ? <Sessions state={state} /> : null}
      </aside>
      <main className={tab === 'chat' ? 'web-main web-pane web-pane-active' : 'web-main web-pane'}>
        <header className="web-toolbar">
          <button type="button" className="web-sheet-open" onClick={() => setSheet('sessions')}>Sessions</button>
          <strong>{state.session.sessionName || view.workspacePath}</strong>
          <span className="web-meta">{state.activity}</span>
          <button type="button" className="web-desktop-only" onClick={() => openDrawer('queue')}>Queue</button>
          <button type="button" className="web-desktop-only" onClick={() => openDrawer('diff')}>Diff</button>
          <button type="button" onClick={() => openDrawer('flows')}>Flows</button>
          <button type="button" onClick={() => openDrawer('settings')}>Settings</button>
        </header>
        <Transcript state={state} />
        <Dialogs state={state} />
        <Composer state={state} />
      </main>
      <section className={tab === 'queue' ? 'web-drawer web-pane web-pane-active' : 'web-drawer web-pane web-desktop-drawer'}>
        {tab === 'queue' || drawer === 'queue' ? <Queue state={state} /> : null}
      </section>
      <section className={tab === 'triage' ? 'web-drawer web-pane web-pane-active' : 'web-drawer web-pane'}>
        {tab === 'triage' ? <Triage state={state} /> : null}
      </section>
      <section className={tab === 'diff' ? 'web-drawer web-pane web-pane-active' : 'web-drawer web-pane web-desktop-drawer'}>
        {tab === 'diff' || drawer === 'diff' ? <Diff state={state} /> : null}
      </section>
      {drawer === 'flows' || drawer === 'settings' || (drawer === 'queue' && tab === 'chat') || (drawer === 'diff' && tab === 'chat') || drawer === 'triage' ? (
        <aside className="web-drawer web-desktop-drawer">
          {drawer === 'queue' ? <Queue state={state} /> : null}
          {drawer === 'diff' ? <Diff state={state} /> : null}
          {drawer === 'triage' ? <Triage state={state} /> : null}
          {drawer === 'flows' ? <Flows state={state} runs={view.flows?.runs} /> : null}
          {drawer === 'settings' ? <Settings state={state} workspacePath={view.workspacePath} onDisconnect={() => workspaceClient().disconnect()} /> : null}
        </aside>
      ) : null}
      {sheet === 'sessions' ? (
        <div className="web-sheet" role="dialog" aria-label="Sessions">
          <button type="button" onClick={() => setSheet(undefined)}>Close</button>
          <Sessions state={state} />
        </div>
      ) : null}
      <nav className="web-tabs" aria-label="Companion tabs">
        <button type="button" className={tab === 'chat' ? 'web-tab-active' : undefined} onClick={() => { setTab('chat'); setDrawer(undefined) }}>Chat</button>
        <button type="button" className={tab === 'queue' ? 'web-tab-active' : undefined} onClick={() => { setTab('queue'); setDrawer('queue') }}>Queue</button>
        <button type="button" className={tab === 'triage' ? 'web-tab-active' : undefined} onClick={() => { setTab('triage'); setDrawer('triage') }}>Triage</button>
        <button type="button" className={tab === 'diff' ? 'web-tab-active' : undefined} onClick={() => { setTab('diff'); setDrawer('diff') }}>Diff</button>
      </nav>
    </div>
  )
}
