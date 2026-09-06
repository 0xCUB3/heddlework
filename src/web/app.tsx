import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react'
import { Composer } from './composer.tsx'
import { webUiContract, panelLabel, surfaceLabel, type WebPanel, type WebSurface } from './contract.ts'
import { Dialogs } from './dialogs.tsx'
import { Diff } from './diff.tsx'
import { Flows } from './flows.tsx'
import { Queue } from './queue.tsx'
import { Receipts } from './receipts.tsx'
import { Sessions } from './sessions.tsx'
import { Settings } from './settings.tsx'
import { Transcript } from './transcript.tsx'
import { Triage } from './triage.tsx'
import { watchWorkspaceNotifications } from './notifications.ts'
import { useWorkspace, workspaceClient } from './store.ts'
import { isLedgerNotice, unreadLedgerNotices } from '../workbench/notices.ts'
import { workspaceDisplayName } from '../workbench/workspace-name.ts'
import { BellIcon, BoxIcon, DownloadIcon, FolderIcon, GitBranchIcon, PanelBottomIcon, PanelLeftIcon, PanelRightIcon, PlusIcon, RefreshIcon, SettingsIcon } from './icons.tsx'

type OverlaySheet = 'navigation' | 'panel' | undefined

export function WebApp() {
  const view = useWorkspace()
  const [surface, setSurface] = useState<WebSurface>('chat')
  const [rightPanel, setRightPanel] = useState<WebPanel | undefined>(undefined)
  const [overlaySheet, setOverlaySheet] = useState<OverlaySheet>(undefined)
  const [actionMenu, setActionMenu] = useState(false)
  const [lastSeenNoticeId, setLastSeenNoticeId] = useState(0)
  const state = view.state

  useEffect(() => watchWorkspaceNotifications(workspaceClient()), [])
  useEffect(() => {
    if (rightPanel === 'notifications' && state) {
      setLastSeenNoticeId(state.notices.filter(isLedgerNotice).at(-1)?.id ?? 0)
      void workspaceClient().sendAndReport({ type: 'markNoticesRead' })
    }
  }, [rightPanel, state])
  useEffect(() => {
    const client = workspaceClient()
    const clientId = webClientId()
    const report = () => {
      const snapshot = client.getSnapshot().state
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      void client.sendAndReport({
        type: 'reportPresence',
        clientId,
        surface: 'web',
        visibility: hidden ? 'hidden' : document.hasFocus() ? 'focused' : 'visible',
        ...(snapshot?.session.sessionFile ? { sessionPath: snapshot.session.sessionFile } : {}),
      })
    }
    report()
    const timer = window.setInterval(report, 15_000)
    document.addEventListener('visibilitychange', report)
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', report)
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
    }
  }, [state?.session.sessionFile])

  if (view.status !== 'open' || !state) {
    return (
      <main className="web-shell web-connect">
        <section className="web-connect-card">
          <p className="web-eyebrow">Heddlework remote</p>
          <h1>Open your workbench anywhere.</h1>
          <p className="web-meta web-error-visible">{view.lastError ?? (view.status === 'connecting' ? 'Connecting…' : 'Not connected. Open a host connect link.')}</p>
        </section>
      </main>
    )
  }

  const unreadCount = unreadLedgerNotices(state.notices).filter((notice) => notice.id > lastSeenNoticeId).length
  const openSurface = (next: WebSurface): void => {
    setSurface(next)
    if (next === 'settings') setRightPanel(undefined)
    setOverlaySheet(undefined)
    setActionMenu(false)
  }
  const openPanel = (next: WebPanel): void => {
    setRightPanel(next)
    setOverlaySheet('panel')
    setActionMenu(false)
  }
  const togglePanel = (next: WebPanel): void => {
    const overlay = window.matchMedia(`(max-width: ${webUiContract.layout.tabletBreakpoint}px)`).matches
    const closing = rightPanel === next && (!overlay || overlaySheet === 'panel')
    setRightPanel(closing ? undefined : next)
    setOverlaySheet(closing ? undefined : 'panel')
  }
  const command = (type: 'newSession' | 'compact' | 'refreshSessions'): void => {
    void workspaceClient().sendAndReport({ type })
  }

  return (
    <div className="web-workbench" data-right-panel={rightPanel ?? 'closed'} data-surface={surface} style={{ '--web-sidebar-width': `${webUiContract.layout.sidebarWidth}px` } as CSSProperties}>
      <aside className="web-sidebar" aria-label="Workbench navigation">
        <SidebarChrome state={state} surface={surface} rightPanel={rightPanel} unreadCount={unreadCount} onSurface={openSurface} onPanel={openPanel} />
      </aside>

      <main className="web-surface">
        {surface === 'settings' ? (
          <header className="web-header web-settings-header">
            <button type="button" className="web-header-icon web-overlay-button" onClick={() => setOverlaySheet('navigation')} aria-label="Open navigation"><PanelLeftIcon /></button>
            <strong className="web-settings-title">Settings</strong>
            <button type="button" className="web-settings-done" onClick={() => openSurface('chat')}>Done</button>
          </header>
        ) : (
          <header className={surface === 'chat' ? 'web-header web-thread-header' : 'web-header'}>
            <button type="button" className="web-header-icon web-overlay-button" onClick={() => setOverlaySheet('navigation')} aria-label="Open navigation"><PanelLeftIcon /></button>
            <div className="web-breadcrumb">
              <FolderIcon className="web-breadcrumb-icon" />
              <span className="web-project-name">{workspaceDisplayName(view.workspacePath)}</span>
              <span className="web-divider">/</span>
              <strong>{surface === 'chat' ? activeThreadTitle(state) : surfaceLabel(surface)}</strong>
            </div>
            <div className="web-header-actions">
              <div className="web-add-action">
                <button type="button" className="web-header-action web-add-action-trigger" aria-expanded={actionMenu} onClick={() => setActionMenu((open) => !open)}><PlusIcon /> <span className="web-header-action-label">Add action</span></button>
                {actionMenu ? (
                  <div className="web-add-action-menu" role="menu">
                    <button type="button" disabled={state.session.isStreaming || state.connection !== 'connected'} onClick={() => { command('newSession'); setActionMenu(false) }}>New thread</button>
                    <button type="button" disabled title="Open the workspace on the desktop host">Open project · desktop only</button>
                    <button type="button" disabled title="Clone stays on the desktop host">Clone thread · desktop only</button>
                    <button type="button" disabled={state.session.isStreaming || state.messages.length === 0} onClick={() => { command('compact'); setActionMenu(false) }}>Compact context</button>
                    <button type="button" onClick={() => { command('refreshSessions'); setActionMenu(false) }}>Refresh sessions</button>
                    <button type="button" disabled title="Export stays on the desktop host">Export transcript · desktop only</button>
                    <button type="button" onClick={() => { openPanel('surfaces'); setActionMenu(false) }}>Surfaces</button>
                  </div>
                ) : null}
              </div>
              <button type="button" className="web-header-action" disabled title="Open the workspace on the desktop host"><BoxIcon /> <span className="web-header-action-label">Open</span></button>
              <button type="button" className="web-header-action" disabled={state.messages.length === 0} title="Export stays on the desktop host"><DownloadIcon /> <span className="web-header-action-label">Export</span></button>
              <button type="button" className="web-header-icon" disabled title="Terminal requires the desktop GPUix window" aria-label="Toggle terminal panel"><PanelBottomIcon /></button>
              <button type="button" className="web-header-icon" onClick={() => { togglePanel('diff'); void workspaceClient().sendAndReport({ type: 'refreshWorkspaceDiff' }) }} aria-label="Toggle Diff panel" aria-pressed={rightPanel === 'diff'}><GitBranchIcon /></button>
              <button type="button" className="web-header-icon web-overlay-button" onClick={() => setOverlaySheet('panel')} aria-label="Open panels"><PanelRightIcon /></button>
            </div>
          </header>
        )}
        {view.lastError ? <div className="web-core-error" role="status">{view.lastError}</div> : null}

        {surface === 'chat' ? (
          state.messages.length === 0 && !state.session.isStreaming ? (
            <section className="web-chat-surface web-chat-empty" aria-label="Chat">
              <div className="web-empty-hero">
                <h1>What should we build in <span>{workspaceDisplayName(view.workspacePath)}</span>?</h1>
                <Composer state={state} hero />
              </div>
              <Dialogs state={state} />
            </section>
          ) : (
            <section className="web-chat-surface" aria-label="Chat">
              <Transcript state={state} />
              <Dialogs state={state} />
              <Composer state={state} />
            </section>
          )
        ) : null}
        {surface === 'flows' ? <SurfaceFrame title="Flows"><Flows state={state} runs={view.flows?.runs} /></SurfaceFrame> : null}
        {surface === 'settings' ? <Settings state={state} workspacePath={view.workspacePath} onDisconnect={() => workspaceClient().disconnect()} /> : null}
      </main>

      {rightPanel ? (
        <aside className="web-right-panel" aria-label={panelLabel(rightPanel)}>
          <PanelHeader panel={rightPanel} onClose={() => setRightPanel(undefined)} />
          <RightPanel panel={rightPanel} state={state} runs={view.flows?.runs} onSurface={openSurface} onPanel={openPanel} />
        </aside>
      ) : null}

      {overlaySheet ? (
        <div className="web-overlay" role="dialog" aria-label={overlaySheet === 'navigation' ? 'Navigation' : 'Panels'}>
          <button type="button" className="web-overlay-backdrop" aria-label="Close" onClick={() => setOverlaySheet(undefined)} />
          <section className={overlaySheet === 'navigation' ? 'web-sheet web-navigation-drawer' : 'web-sheet'}>
            <div className="web-sheet-header">
              <strong>{overlaySheet === 'navigation' ? 'Heddlework' : rightPanel ? panelLabel(rightPanel) : 'Panels'}</strong>
              <button type="button" onClick={() => setOverlaySheet(undefined)}>Done</button>
            </div>
            {overlaySheet === 'navigation'
              ? <SidebarChrome state={state} surface={surface} rightPanel={rightPanel} unreadCount={unreadCount} onSurface={openSurface} onPanel={openPanel} />
              : rightPanel
                ? <RightPanel panel={rightPanel} state={state} runs={view.flows?.runs} onSurface={openSurface} onPanel={openPanel} />
                : <PanelPicker active={rightPanel} onPanel={openPanel} />}
          </section>
        </div>
      ) : null}
    </div>
  )
}

function SidebarChrome({ state, surface, rightPanel, unreadCount, onSurface, onPanel }: { state: NonNullable<ReturnType<typeof useWorkspace>['state']>; surface: WebSurface; rightPanel: WebPanel | undefined; unreadCount: number; onSurface(surface: WebSurface): void; onPanel(panel: WebPanel): void }) {
  return (
    <div className="web-sidebar-inner">
      <div className="web-brand"><strong>Heddlework</strong></div>
      <div className="web-sidebar-controls">
        <button type="button" className={surface === 'flows' ? 'web-flows-row web-nav-active' : 'web-flows-row'} onClick={() => onSurface(surface === 'flows' ? 'chat' : 'flows')}>
          <GitBranchIcon />
          <span>Flows</span>
        </button>
      </div>
      <div className="web-sidebar-section web-sidebar-grow">
        <Sessions state={state} />
      </div>
      <div className="web-sidebar-footer">
        <button type="button" className={surface === 'settings' ? 'web-icon-nav web-nav-active' : 'web-icon-nav'} onClick={() => onSurface(surface === 'settings' ? 'chat' : 'settings')} aria-label="Settings"><SettingsIcon /></button>
        <span className="web-footer-bell">
          <button type="button" className={rightPanel === 'notifications' ? 'web-icon-nav web-nav-active' : 'web-icon-nav'} onClick={() => onPanel('notifications')} aria-label="Notifications"><BellIcon /></button>
          {unreadCount > 0 ? <span className="web-unread">{Math.min(99, unreadCount)}</span> : null}
        </span>
        <button type="button" className="web-icon-nav" onClick={() => void workspaceClient().sendAndReport({ type: 'refreshSessions' })} aria-label="Refresh threads"><RefreshIcon /></button>
        <span className={`web-connection-dot web-connection-${state.connection}`} aria-label={state.connection} />
      </div>
    </div>
  )
}

function PanelPicker({ active, onPanel }: { active: WebPanel | undefined; onPanel(panel: WebPanel): void }) {
  return (
    <div className="web-panel-picker">
      <p className="web-section-label">Panels</p>
      {webUiContract.panels.map((panel) => <button key={panel.id} type="button" className={active === panel.id ? 'web-nav-item web-nav-active' : 'web-nav-item'} onClick={() => onPanel(panel.id)}>{panel.label}</button>)}
    </div>
  )
}

function PanelHeader({ panel, onClose }: { panel: WebPanel; onClose(): void }) {
  return <header className="web-panel-header"><strong>{panelLabel(panel)}</strong><button type="button" onClick={onClose}>Close</button></header>
}

function RightPanel({ panel, state, runs, onSurface, onPanel }: { panel: WebPanel; state: NonNullable<ReturnType<typeof useWorkspace>['state']>; runs?: Parameters<typeof Flows>[0]['runs']; onSurface(surface: WebSurface): void; onPanel(panel: WebPanel): void }) {
  if (panel === 'notifications') return <NotificationsPanel state={state} />
  if (panel === 'surfaces') return <SurfacesPanel onSurface={onSurface} onPanel={onPanel} />
  if (panel === 'diff') return <Diff state={state} />
  if (panel === 'queue') return <Queue state={state} />
  if (panel === 'triage') return <Triage state={state} />
  if (panel === 'receipts') return <Receipts state={state} />
  return <p className="web-empty">{panelLabel(panel)} is unavailable on this remote.</p>
}

function NotificationsPanel({ state }: { state: NonNullable<ReturnType<typeof useWorkspace>['state']> }) {
  const notices = useMemo(() => [...state.notices.filter(isLedgerNotice)].reverse(), [state.notices])
  if (notices.length === 0) return <p className="web-empty">Completions, failures, and requests for input land here.</p>
  return (
    <div className="web-notices">
      <button type="button" onClick={() => void workspaceClient().sendAndReport({ type: 'clearNotices' })}>Clear all</button>
      {notices.map((notice) => (
        <article key={notice.id} className={`web-notice-row${notice.readAt ? '' : ' web-notice-unread'}`}>
          <button type="button" className="web-notice-open" onClick={() => void workspaceClient().sendAndReport({ type: 'activateNotice', id: notice.id })}>
            <strong>{notice.sessionTitle || notice.kind}</strong>
            <p>{notice.message}</p>
            <span>{new Date(notice.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
          </button>
          <button type="button" onClick={() => void workspaceClient().sendAndReport({ type: 'dismissNotice', id: notice.id })}>Dismiss</button>
        </article>
      ))}
    </div>
  )
}

function SurfacesPanel({ onSurface, onPanel }: { onSurface(surface: WebSurface): void; onPanel(panel: WebPanel): void }) {
  return <div className="web-surfaces-panel"><p className="web-empty">Remote surfaces mirror the desktop workbench. Terminal and browser docks require the GPUix desktop window and are not available in the browser remote.</p><button type="button" className="web-card web-surface-card" onClick={() => onSurface('chat')}><strong>Chat</strong><span className="web-empty">Return to the transcript</span></button><button type="button" className="web-card web-surface-card" onClick={() => onSurface('flows')}><strong>Flows</strong><span className="web-empty">Open flow runs</span></button><button type="button" className="web-card web-surface-card" onClick={() => onPanel('queue')}><strong>Queue</strong><span className="web-empty">Remote queue controls are available here.</span></button><button type="button" className="web-card web-surface-card" onClick={() => onPanel('triage')}><strong>Triage</strong></button><button type="button" className="web-card web-surface-card" onClick={() => onPanel('receipts')}><strong>Receipts</strong></button></div>
}

function SurfaceFrame({ title, children }: { title: string; children: ReactNode }) {
  return <section className="web-surface-frame"><div className="web-surface-content"><h2>{title}</h2>{children}</div></section>
}

function webClientId(): string {
  if (typeof sessionStorage === 'undefined') return 'web'
  const key = 'heddlework.clientId'
  const existing = sessionStorage.getItem(key)
  if (existing) return existing
  const id = `web-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Date.now())}`
  sessionStorage.setItem(key, id)
  return id
}

function activeThreadTitle(state: NonNullable<ReturnType<typeof useWorkspace>['state']>): string {
  if (state.session.sessionName) return state.session.sessionName
  const current = state.sessions.find((session) => session.path === state.session.sessionFile)
  if (current?.title) return current.title
  const firstUser = state.messages.find((message) => message.role === 'user')
  if (firstUser && typeof firstUser.content === 'string') return firstUser.content.length > 68 ? `${firstUser.content.slice(0, 65)}…` : firstUser.content
  return 'New thread'
}
