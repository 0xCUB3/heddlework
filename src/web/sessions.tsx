import { useMemo, useState } from 'react'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { workspaceClient } from './store.ts'
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, ClockIcon, FolderIcon, FolderPlusIcon, GitBranchIcon, SearchIcon, EditIcon } from './icons.tsx'

const ALL_PROJECTS = '__all-projects__'
const SETTLED_AFTER_MS = 7 * 24 * 60 * 60 * 1_000

function sessionLifecycleBucket(session: WorkbenchSnapshot['sessions'][number], lifecycle: WorkbenchSnapshot['threadLifecycle'][string] | undefined, now: number): 'active' | 'snoozed' | 'settled' {
  if ((lifecycle?.snoozedUntil ?? 0) > now) return 'snoozed'
  if ((lifecycle?.settledAt ?? 0) >= session.modifiedAt) return 'settled'
  if ((lifecycle?.unsettledAt ?? 0) > session.modifiedAt) return 'active'
  if (now - session.modifiedAt > SETTLED_AFTER_MS) return 'settled'
  return 'active'
}

export function Sessions({ state }: { state: WorkbenchSnapshot }) {
  const client = workspaceClient()
  const [search, setSearch] = useState('')
  const [project, setProject] = useState(ALL_PROJECTS)
  const [settledExpanded, setSettledExpanded] = useState(false)
  const [snoozePath, setSnoozePath] = useState<string | null>(null)
  const now = Date.now()
  const projects = useMemo(() => {
    const seen = new Map<string, string>()
    for (const session of state.sessions) seen.set(session.cwd, basename(session.cwd))
    return [{ value: ALL_PROJECTS, label: 'All projects' }, ...[...seen].map(([value, label]) => ({ value, label })).sort((left, right) => left.label.localeCompare(right.label))]
  }, [state.sessions])
  const normalized = search.trim().toLowerCase()
  const persisted = useMemo(() => state.sessions.filter((session) => session.messageCount > 0), [state.sessions])
  const sessions = useMemo(() => persisted.filter((session) => {
    if (project !== ALL_PROJECTS && session.cwd !== project) return false
    if (!normalized) return true
    return `${session.title} ${session.name ?? ''} ${session.firstMessage} ${session.cwd}`.toLowerCase().includes(normalized)
  }), [normalized, persisted, project])
  const active = sessions.filter((session) => sessionLifecycleBucket(session, state.threadLifecycle[session.path], now) === 'active')
  const snoozed = sessions.filter((session) => sessionLifecycleBucket(session, state.threadLifecycle[session.path], now) === 'snoozed')
  const settled = sessions.filter((session) => sessionLifecycleBucket(session, state.threadLifecycle[session.path], now) === 'settled')
  const renderedSettled = settledExpanded ? settled : settled.filter((session) => session.path === state.session.sessionFile)

  return (
    <nav className="web-sessions">
      <div className="web-sidebar-search-row">
        <label className="web-sidebar-search-box"><SearchIcon /><input type="search" value={search} placeholder="Search" aria-label="Search sessions" onChange={(event) => setSearch(event.target.value)} /></label>
        <button type="button" className="web-sidebar-new" onClick={() => void client.sendAndReport({ type: 'newSession' })} aria-label="New thread"><EditIcon /></button>
      </div>
      <div className="web-session-toolbar">
        <div className="web-project-select"><FolderIcon /><select value={project} aria-label="Project filter" onChange={(event) => setProject(event.target.value)}>{projects.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select><ChevronDownIcon /></div>
        <button type="button" className="web-sidebar-new" disabled title="Add projects from the desktop workspace" aria-label="Add project on desktop"><FolderPlusIcon /></button>
      </div>
      <ul className="web-list">
        {active.map((session) => (
          <li key={session.path}>
            <SessionCard
              state={state}
              session={session}
              snoozeOpen={snoozePath === session.path}
              onSnooze={() => setSnoozePath((current) => current === session.path ? null : session.path)}
              onSchedule={(until) => { setSnoozePath(null); void client.sendAndReport({ type: 'snoozeThread', path: session.path, snoozedUntil: until }) }}
            />
          </li>
        ))}
        {snoozed.length > 0 ? <li className="web-session-section web-session-section-accent">Snoozed ({snoozed.length})</li> : null}
        {snoozed.map((session) => <li key={session.path}><CompactSession state={state} session={session} lifecycle="snoozed" /></li>)}
        {settled.length > 0 ? (
          <li>
            <button type="button" className="web-settled-toggle" onClick={() => setSettledExpanded((value) => !value)}>
              <span>{settledExpanded ? 'Settled' : `Settled (${settled.length})`}</span>
              <span className="web-settled-rule" />
              {settledExpanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
            </button>
          </li>
        ) : null}
        {renderedSettled.map((session) => <li key={session.path}><CompactSession state={state} session={session} lifecycle="settled" /></li>)}
      </ul>
      {sessions.length === 0 ? <p className="web-empty">{normalized ? 'No threads found' : 'No threads in this project'}</p> : null}
      {state.sessionsHasMore ? <button type="button" className="web-session-more" onClick={() => void client.sendAndReport({ type: 'loadMoreSessions' })}>Load more</button> : null}
    </nav>
  )
}

function SessionCard({ state, session, snoozeOpen, onSnooze, onSchedule }: { state: WorkbenchSnapshot; session: WorkbenchSnapshot['sessions'][number]; snoozeOpen: boolean; onSnooze(): void; onSchedule(until: number): void }) {
  const client = workspaceClient()
  const active = session.path === state.session.sessionFile
  const running = active && state.session.isStreaming
  const title = session.name || session.title || session.id
  const branch = session.cwd === state.workspacePath ? (state.workspaceDiff.branch || 'main') : 'saved session'
  return (
    <div className={active ? 'web-session-card web-session-card-active' : 'web-session-card'}>
      <button
        type="button"
        className={active ? 'web-session-active' : 'web-session'}
        title={title}
        aria-current={active ? 'page' : undefined}
        onClick={() => void client.sendAndReport({ type: 'switchSession', path: session.path })}
      >
        <div className="web-session-project"><FolderIcon />{basename(session.cwd)}</div>
        <strong>{title}</strong>
        <div className="web-session-branch"><GitBranchIcon />{branch}</div>
      </button>
      <div className="web-session-meta">
        <span>{running ? 'Working' : relativeTime(session.modifiedAt)}</span>
        <button type="button" className="web-session-icon" aria-label="Snooze" onClick={onSnooze}><ClockIcon /></button>
        <button type="button" className="web-session-icon" aria-label="Settle" onClick={() => void client.sendAndReport({ type: 'settleThread', path: session.path })}><CheckIcon /> Settle</button>
      </div>
      {snoozeOpen ? <SnoozeMenu onSchedule={onSchedule} /> : null}
    </div>
  )
}

function CompactSession({ state, session, lifecycle }: { state: WorkbenchSnapshot; session: WorkbenchSnapshot['sessions'][number]; lifecycle: 'snoozed' | 'settled' }) {
  const client = workspaceClient()
  const title = session.name || session.title || session.id
  const until = state.threadLifecycle[session.path]?.snoozedUntil
  return (
    <div className={lifecycle === 'settled' ? 'web-session-compact web-session-settled' : 'web-session-compact'}>
      <button type="button" className={session.path === state.session.sessionFile ? 'web-session-active' : 'web-session'} title={title} aria-current={session.path === state.session.sessionFile ? 'page' : undefined} onClick={() => void client.sendAndReport({ type: 'switchSession', path: session.path })}>
        {lifecycle === 'snoozed' ? <ClockIcon /> : <EditIcon />}
        <strong>{title}</strong>
      </button>
      <span>{lifecycle === 'snoozed' && until ? new Date(until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : relativeTime(session.modifiedAt)}</span>
      <button type="button" className="web-session-icon" aria-label="Wake" onClick={() => void client.sendAndReport({ type: 'wakeThread', path: session.path })}><CheckIcon /></button>
    </div>
  )
}

function SnoozeMenu({ onSchedule }: { onSchedule(until: number): void }) {
  const now = Date.now()
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(9, 0, 0, 0)
  const nextWeek = new Date(now)
  nextWeek.setDate(nextWeek.getDate() + ((8 - nextWeek.getDay()) % 7 || 7))
  nextWeek.setHours(9, 0, 0, 0)
  const options = [
    { label: 'In 1 hour', value: now + 60 * 60 * 1_000 },
    { label: 'In 3 hours', value: now + 3 * 60 * 60 * 1_000 },
    { label: 'Tomorrow', value: tomorrow.getTime() },
    { label: 'Next week', value: nextWeek.getTime() },
  ]
  return (
    <div className="web-snooze-menu" role="menu">
      {options.map((option) => (
        <button key={option.label} type="button" onClick={() => onSchedule(option.value)}>{option.label}</button>
      ))}
    </div>
  )
}

function basename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts.at(-1) ?? path
}

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
