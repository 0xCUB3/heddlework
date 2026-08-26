import React, { useEffect, useMemo, useState } from 'react'
import { resolve } from 'node:path'
import { sessionProjectName, type PiSessionSummary } from '../pi/session-catalog.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { contentText, type WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { IconButton } from './primitives.tsx'
import { launchWorkspaceWindow } from './open-external.ts'
import { colors } from './theme.ts'

export function WorkbenchSidebar({
  state,
  controller,
  settingsActive,
  notificationsActive,
  unreadCount,
  onSettings,
  onNotifications,
}: {
  state: WorkbenchState
  controller: WorkbenchController
  settingsActive: boolean
  notificationsActive: boolean
  unreadCount: number
  onSettings(): void
  onNotifications(): void
}) {
  const [search, setSearch] = useState('')
  const [projectExpanded, setProjectExpanded] = useState(true)
  const [showProjectLauncher, setShowProjectLauncher] = useState(false)
  const [snoozeMenu, setSnoozeMenu] = useState<string | null>(null)
  const [clock, setClock] = useState(Date.now())
  const activePath = state.session.sessionFile
  const activeSummary = useMemo(
    () => state.sessions.find((session) => session.path === activePath) ?? syntheticActiveSession(state),
    [activePath, state],
  )
  const normalizedSearch = search.trim().toLowerCase()
  const matchingSessions = useMemo(() => {
    const unique = new Map<string, PiSessionSummary>()
    if (activeSummary) unique.set(activeSummary.path, activeSummary)
    for (const session of state.sessions) unique.set(session.path, session)
    const sessions = [...unique.values()]
    return normalizedSearch
      ? sessions.filter((session) => `${session.title} ${session.firstMessage} ${sessionProjectName(session)} ${session.cwd}`.toLowerCase().includes(normalizedSearch))
      : sessions
  }, [activeSummary, normalizedSearch, state.sessions])
  const visibleSessions = matchingSessions
  const now = clock
  useEffect(() => {
    const currentTime = Date.now()
    const nextWake = Object.values(state.threadLifecycle)
      .map((lifecycle) => lifecycle.snoozedUntil)
      .filter((value): value is number => typeof value === 'number' && value > currentTime)
      .sort((left, right) => left - right)[0]
    const nextMinute = currentTime + (60_000 - currentTime % 60_000)
    const refreshAt = Math.min(nextWake ?? Number.POSITIVE_INFINITY, nextMinute)
    const timer = setTimeout(() => setClock(Date.now()), Math.max(25, refreshAt - currentTime + 10))
    return () => clearTimeout(timer)
  }, [now, state.threadLifecycle])
  const activeSessions = visibleSessions.filter((session) => {
    const lifecycle = state.threadLifecycle[session.path]
    return !lifecycle?.settledAt && !(lifecycle?.snoozedUntil && lifecycle.snoozedUntil > now)
  })
  const snoozedSessions = visibleSessions.filter((session) => (state.threadLifecycle[session.path]?.snoozedUntil ?? 0) > now)
  const settledSessions = visibleSessions.filter((session) => Boolean(state.threadLifecycle[session.path]?.settledAt))
  const connectionColor = state.connection === 'connected'
    ? colors.success
    : state.connection === 'connecting'
      ? colors.warning
      : colors.error

  const renderSession = (session: PiSessionSummary, lifecycle: 'active' | 'snoozed' | 'settled') => {
    const active = session.path === activePath || session.id === state.session.sessionId
    return (
      <SessionRow
        key={session.path}
        session={session}
        projectName={sessionProjectName(session)}
        active={active}
        running={active && state.session.isStreaming}
        disabled={state.session.isStreaming && !active}
        lifecycle={lifecycle}
        {...(state.threadLifecycle[session.path]?.snoozedUntil === undefined ? {} : { snoozedUntil: state.threadLifecycle[session.path]!.snoozedUntil })}
        branch={resolve(session.cwd) === resolve(state.workspacePath) ? state.workspaceDiff.branch || 'main' : 'saved session'}
        snoozeOpen={snoozeMenu === session.path}
        onClick={() => {
          if (resolve(session.cwd) === resolve(state.workspacePath)) void controller.switchSession(session)
          else launchWorkspaceWindow(session.cwd, session.path)
        }}
        onSettle={() => { setSnoozeMenu(null); controller.settleThread(session.path) }}
        onWake={() => controller.wakeThread(session.path)}
        onSnooze={() => setSnoozeMenu((current) => current === session.path ? null : session.path)}
        onSchedule={(until) => { setSnoozeMenu(null); controller.snoozeThread(session.path, until) }}
      />
    )
  }

  return (
    <div testId="sidebar" style={{ position: 'relative', width: 256, flexShrink: 0, height: '100%', display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.sidebar, userSelect: 'none', overflow: 'visible' }}>
      <BrandHeader />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 8, paddingTop: 6 }}>
        <div style={{ alignSelf: 'stretch', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, paddingRight: 6 }}>
          <div style={{ height: 32, minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 7, borderRadius: 8, hover: { backgroundColor: colors.sidebarHover } }}>
            <Icon name="search" size={15} color={colors.textFaint} />
            <input
              testId="sidebar-search"
              value={search}
              placeholder="Search"
              theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }}
              style={{ minWidth: 0, flexGrow: 1, height: 26, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 12 }}
              onChange={(event) => setSearch(String(event.value ?? ''))}
            />
          </div>
          <IconButton testId="sidebar-new-thread" icon="squarePen" label="New thread" disabled={state.session.isStreaming || state.connection !== 'connected'} onClick={() => void controller.newSession()} />
        </div>

        <div style={{ alignSelf: 'stretch', height: 34, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <div
            testId="sidebar-project-toggle"
            tabIndex={0}
            style={{ minWidth: 0, flexGrow: 1, height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 14, borderRadius: 8, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }}
            onClick={() => setProjectExpanded((value) => !value)}
          >
            <Icon name="folder" size={15} color={colors.textFaint} />
            <text testId="sidebar-project-label" style={{ color: colors.textMuted, fontSize: 12, fontWeight: 550 }}>All projects</text>
            <div style={{ flexGrow: 1 }} />
            <div testId="sidebar-project-chevron" style={{ width: 12, height: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <Icon name={projectExpanded ? 'chevronDown' : 'chevronRight'} size={12} color={colors.textFaint} />
            </div>
          </div>
          <IconButton testId="sidebar-new-project" icon="folderPlus" label="New project" onClick={() => setShowProjectLauncher((value) => !value)} />
        </div>
        {showProjectLauncher && <ProjectLauncher onClose={() => setShowProjectLauncher(false)} />}
      </div>

      <virtual-list alignment="top" estimatedItemHeight={78} overdraw={280} style={{ flexGrow: 1, minHeight: 0, width: '100%', paddingLeft: 8, paddingRight: 8 }}>
        {projectExpanded && (
          <>
            {activeSessions.map((session) => renderSession(session, 'active'))}
            {snoozedSessions.length > 0 && <SectionLabel label={`Snoozed (${snoozedSessions.length})`} tone="accent" />}
            {snoozedSessions.map((session) => renderSession(session, 'snoozed'))}
            {settledSessions.length > 0 && <SectionLabel label="Settled" />}
            {settledSessions.map((session) => renderSession(session, 'settled'))}
            {visibleSessions.length === 0 && (
              <div style={{ paddingTop: 22, paddingLeft: 78 }}>
                <text style={{ color: colors.textFaint, fontSize: 11 }}>{normalizedSearch ? 'No threads found' : 'No threads yet'}</text>
              </div>
            )}
          </>
        )}
      </virtual-list>

      <div style={{ height: 46, paddingLeft: 8, paddingRight: 8, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2, flexShrink: 0 }}>
        <IconButton icon="settings" label="Settings" testId="sidebar-settings" active={settingsActive} onClick={onSettings} />
        <div style={{ position: 'relative' }}>
          <IconButton icon="bell" label="Notifications" testId="sidebar-notifications" active={notificationsActive} onClick={onNotifications} />
          {unreadCount > 0 && <div style={{ position: 'absolute', top: 2, right: 1, minWidth: 13, height: 13, borderRadius: 7, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 3, paddingRight: 3, backgroundColor: colors.primary }}><text style={{ color: '#FFFFFF', fontSize: 7, fontWeight: 700 }}>{String(Math.min(99, unreadCount))}</text></div>}
        </div>
        <IconButton icon="refresh" label="Refresh threads" disabled={state.sessionsLoading} onClick={() => void controller.refreshSessions()} />
        <div style={{ flexGrow: 1 }} />
        <div testId="sidebar-connection-status" style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: connectionColor }} />
        </div>
      </div>
    </div>
  )
}

function BrandHeader() {
  return (
    <div testId="sidebar-brand" style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, backgroundColor: colors.sidebar }}>
      <text style={{ color: colors.textMuted, fontSize: 12, fontWeight: 750 }}>π</text>
      <text style={{ color: colors.textMuted, fontSize: 13, fontWeight: 550 }}>Code</text>
    </div>
  )
}

function SectionLabel({ label, tone = 'normal' }: { label: string; tone?: 'normal' | 'accent' }) {
  return (
    <div style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 11, paddingRight: 8 }}>
      <text style={{ color: tone === 'accent' ? colors.info : colors.textFaint, fontSize: 10 }}>{label}</text>
      <div style={{ height: 1, flexGrow: 1, backgroundColor: tone === 'accent' ? '#153A5A' : colors.border }} />
      <Icon name="chevronDown" size={10} color={tone === 'accent' ? colors.info : colors.textFaint} />
    </div>
  )
}

function SessionRow({
  session,
  projectName,
  active,
  running,
  disabled,
  lifecycle,
  snoozedUntil,
  branch,
  snoozeOpen,
  onClick,
  onSettle,
  onWake,
  onSnooze,
  onSchedule,
}: {
  session: PiSessionSummary
  projectName: string
  active: boolean
  running: boolean
  disabled: boolean
  lifecycle: 'active' | 'snoozed' | 'settled'
  snoozedUntil?: number
  branch: string
  snoozeOpen: boolean
  onClick(): void
  onSettle(): void
  onWake(): void
  onSnooze(): void
  onSchedule(until: number): void
}) {
  const [hovered, setHovered] = useState(false)
  if (lifecycle !== 'active') {
    return (
      <div style={{ height: 36, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 6, borderRadius: 7, hover: { backgroundColor: colors.sidebarHover } }}>
        <Icon name={lifecycle === 'snoozed' ? 'clock' : 'squarePen'} size={13} color={lifecycle === 'snoozed' ? colors.info : colors.textFaint} />
        <div tabIndex={disabled ? -1 : 0} style={{ minWidth: 0, flexGrow: 1, cursor: disabled ? 'default' : 'pointer' }} {...(disabled ? {} : { onClick })}>
          <text style={{ color: colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
        </div>
        <text style={{ color: colors.textFaint, fontSize: 9 }}>{lifecycle === 'snoozed' && snoozedUntil ? new Date(snoozedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : relativeTime(session.modifiedAt)}</text>
        <div testId="sidebar-wake" tabIndex={0} style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }} onClick={onWake}>
          <Icon name="check" size={12} color={colors.textFaint} />
        </div>
      </div>
    )
  }

  return (
    <div testId={active ? 'sidebar-session-card-active' : 'sidebar-session-card'} style={{ position: 'relative', width: '100%', height: 78, minHeight: 78, maxHeight: 78, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 4, padding: 9, borderRadius: 8, backgroundColor: active ? colors.sidebarActive : colors.transparent, opacity: disabled ? 0.45 : 1, hover: { backgroundColor: colors.sidebarHover }, overflow: 'visible' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <div style={{ width: '100%', minWidth: 0, height: 20, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
        <Icon name="folder" size={13} color={colors.textFaint} />
        <text style={{ color: colors.textMuted, fontSize: 10, fontWeight: 550, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{projectName}</text>
        <div style={{ width: 70, height: 20, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
          {hovered || snoozeOpen ? (
            <>
              <div testId="sidebar-snooze" tabIndex={0} style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onClick={onSnooze}>
                <Icon name="clock" size={12} color={colors.textFaint} />
              </div>
              <div testId="sidebar-settle" tabIndex={0} style={{ height: 20, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 3, paddingLeft: 3, paddingRight: 2, cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onClick={onSettle}>
                <Icon name="check" size={11} color={colors.textFaint} />
                <text style={{ color: colors.textFaint, fontSize: 9 }}>Settle</text>
              </div>
            </>
          ) : (
            <>
              <text style={{ color: running ? colors.info : colors.textFaint, fontSize: 9 }}>{running ? 'Working' : relativeTime(session.modifiedAt)}</text>
              <text style={{ color: '#E9705A', fontSize: 10, fontWeight: 700 }}>π</text>
            </>
          )}
        </div>
      </div>
      <div testId={active ? 'sidebar-session-active' : 'sidebar-session-row'} tabIndex={disabled ? -1 : 0} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0, cursor: disabled ? 'default' : 'pointer' }} {...(disabled ? {} : { onClick })}>
        <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 12, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5 }}>
          <Icon name="gitBranch" size={11} color={colors.textFaint} />
          <text style={{ color: colors.textFaint, fontSize: 9 }}>{branch}</text>
        </div>
      </div>
      {snoozeOpen && <SnoozeMenu onSchedule={onSchedule} />}
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
    <div testId="snooze-menu" style={{ position: 'absolute', top: 28, right: 3, width: 204, display: 'flex', flexDirection: 'column', padding: 5, borderRadius: 9, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover }}>
      {options.map((option, index) => (
        <React.Fragment key={option.label}>
          <div testId={`snooze-option-${index}`} tabIndex={0} style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => onSchedule(option.value)}>
            <text style={{ color: colors.textMuted, fontSize: 11 }}>{option.label}</text>
            <div style={{ flexGrow: 1 }} />
            <text style={{ color: colors.textFaint, fontSize: 9 }}>{new Date(option.value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</text>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}


function ProjectLauncher({ onClose }: { onClose(): void }) {
  const [path, setPath] = useState('')
  const launch = () => {
    const target = path.trim()
    if (!target) return
    launchWorkspaceWindow(target)
    onClose()
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover }}>
      <text style={{ color: colors.text, fontSize: 11, fontWeight: 600 }}>Open project in a new window</text>
      <input value={path} placeholder="/absolute/path/to/project" autoFocus theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.input }} style={{ height: 30, width: '100%', paddingLeft: 8, paddingRight: 8, borderWidth: 1, borderColor: colors.borderStrong, borderRadius: 6, backgroundColor: colors.input, color: colors.text, fontSize: 11 }} onChange={(event) => setPath(String(event.value ?? ''))} onSubmit={launch} />
      <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', gap: 6 }}>
        <SidebarTextAction label="Cancel" onClick={onClose} />
        <SidebarTextAction label="Open" onClick={launch} />
      </div>
    </div>
  )
}

function SidebarTextAction({ label, onClick }: { label: string; onClick(): void }) {
  return <div tabIndex={0} style={{ height: 28, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.sidebarHover } }} onClick={onClick}><text style={{ color: colors.textMuted, fontSize: 10, fontWeight: 550 }}>{label}</text></div>
}

function syntheticActiveSession(state: WorkbenchState): PiSessionSummary | null {
  if (!state.session.sessionId && state.messages.length === 0) return null
  const firstUser = state.messages.find((message) => message.role === 'user')
  const firstMessage = firstUser ? contentText(firstUser.content).trim() : ''
  return {
    id: state.session.sessionId ?? 'current',
    path: state.session.sessionFile ?? `current:${state.session.sessionId ?? 'new'}`,
    cwd: state.workspacePath,
    title: state.session.sessionName ?? compactTitle(firstMessage || 'New thread'),
    ...(state.session.sessionName ? { name: state.session.sessionName } : {}),
    firstMessage: firstMessage || '(no messages)',
    messageCount: state.messages.length,
    createdAt: Date.now(),
    modifiedAt: state.messages.at(-1)?.timestamp ?? Date.now(),
  }
}

function compactTitle(value: string): string {
  return value.length > 60 ? `${value.slice(0, 57)}…` : value
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
