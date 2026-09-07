import React, { useEffect, useState } from 'react'
import { useWindowSize } from '@gpuix/react'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket, sortActiveSessions } from '../workbench/thread-lifecycle.ts'
import { DropdownSurface, useDropdownPresence } from './dropdown.tsx'
import { Icon } from './icons.tsx'
import { useResponsiveLayout } from './responsive.tsx'
import { colors } from './theme.ts'
import { buildThreadActions, type ThreadAction, type ThreadActionId } from './thread-actions.ts'

const SIDEBAR_BORDER_WIDTH = 1
const SESSION_ROW_INSET = 8
const QUICK_ACTIONS_WIDTH = 78
const MORE_ACTIONS_WIDTH = 108

export { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket, sortActiveSessions }

function SessionRowInset({ sidebarWidth, height, children }: { sidebarWidth: number; height: number; children: React.ReactNode }) {
  const width = sidebarWidth - 2 * SIDEBAR_BORDER_WIDTH
  return <div testId="sidebar-session-inset" style={{ width, height, flexShrink: 0, paddingLeft: SESSION_ROW_INSET, paddingRight: SESSION_ROW_INSET }}>{children}</div>
}

export function SessionRow({
  sidebarWidth,
  session,
  projectName,
  active,
  running,
  disabled,
  lifecycle,
  snoozedUntil,
  snoozeOpen,
  moreOpen = false,
  pinned = false,
  onClick,
  onSettle,
  onWake,
  onSnooze,
  onSchedule,
  onMore,
  onAction,
  onRename,
}: {
  sidebarWidth: number
  session: PiSessionSummary
  projectName: string
  active: boolean
  running: boolean
  disabled: boolean
  lifecycle: 'active' | 'snoozed' | 'settled'
  snoozedUntil?: number
  snoozeOpen: boolean
  moreOpen?: boolean
  pinned?: boolean
  onClick(): void
  onSettle(): void
  onWake(): void
  onSnooze(): void
  onSchedule(until: number): void
  onMore?(): void
  onAction?(id: ThreadActionId): void
  onRename?(name: string): void
}) {
  const { compact } = useResponsiveLayout()
  const height = session.branch ? 74 : 56
  const metadataColor = active ? colors.sidebarActiveMuted : colors.textFaint
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(session.title)
  const activation = disabled || renaming ? {} : {
    onClick,
    onKeyDown: (event: { key?: string }) => {
      if (event.key === 'enter' || event.key === 'space') onClick()
    },
  }
  const [hovered, setHovered] = useState(false)
  const [settleHovered, setSettleHovered] = useState(false)
  const [actionsHovered, setActionsHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const snoozeMounted = useDropdownPresence(snoozeOpen)
  const moreMounted = useDropdownPresence(moreOpen)
  const showMore = Boolean(onMore)
  const actionsWidth = showMore ? MORE_ACTIONS_WIDTH : QUICK_ACTIONS_WIDTH
  const showActions = compact || hovered || actionsHovered || focused || snoozeMounted || moreMounted
  useEffect(() => {
    if (!active) setRenaming(false)
  }, [active])
  useEffect(() => {
    if (!renaming) setDraft(session.title)
  }, [renaming, session.title])

  const actions = buildThreadActions({
    isPinned: pinned,
    isSettled: lifecycle === 'settled',
    isSnoozed: lifecycle === 'snoozed',
    isRunning: running,
    hasMessages: session.messageCount > 0,
  }).map((action) => {
    if (action.id === 'rename' && !active) return { ...action, disabled: true, detail: 'Open the thread to rename it' }
    if ((action.id === 'clone' || action.id === 'export') && !active) {
      return { ...action, disabled: true, detail: action.id === 'clone' ? 'Open the thread to clone it' : 'Open the thread to export it' }
    }
    return action
  })

  const commitRename = () => {
    onRename?.(draft)
    if (draft.trim()) setRenaming(false)
  }

  if (lifecycle !== 'active') {
    return (
      <SessionRowInset sidebarWidth={sidebarWidth} height={36}>
        <div testId={lifecycle === 'settled' ? 'sidebar-settled-row' : 'sidebar-snoozed-row'} style={{ position: 'relative', height: 36, borderRadius: 7, hover: { backgroundColor: colors.sidebarHover } }}>
          <div testId="sidebar-history-open" tabIndex={disabled ? -1 : 0} {...activation} style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 34, cursor: disabled ? 'default' : 'pointer' }}>
            <Icon name={lifecycle === 'snoozed' ? 'clock' : 'squarePen'} size={13} color={lifecycle === 'snoozed' ? colors.info : colors.settledIcon} />
            <text {...(lifecycle === 'settled' ? { testId: 'sidebar-settled-title' } : {})} style={{ minWidth: 0, flexGrow: 1, color: lifecycle === 'settled' ? colors.settledText : colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
            <text style={{ color: lifecycle === 'settled' ? colors.settledMeta : colors.textFaint, fontSize: 9 }}>{lifecycle === 'snoozed' && snoozedUntil ? new Date(snoozedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : relativeTime(session.modifiedAt)}</text>
          </div>
          <div testId="sidebar-wake" tabIndex={disabled ? -1 : 0} style={{ position: 'absolute', top: 5, right: 4, width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onClick={() => { if (!disabled) onWake() }} onKeyDown={event => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onWake() }}>
            <Icon name="check" size={12} color={lifecycle === 'settled' ? colors.settledIcon : colors.textFaint} />
          </div>
        </div>
      </SessionRowInset>
    )
  }

  return (
    <SessionRowInset sidebarWidth={sidebarWidth} height={height + 4}>
      <div testId={active ? 'sidebar-session-card-active' : 'sidebar-session-card'} style={{ position: 'relative', height, minHeight: height, maxHeight: height, flexShrink: 0, borderRadius: 8, backgroundColor: active ? colors.sidebarActive : hovered || actionsHovered || focused ? colors.sidebarHover : colors.transparent, opacity: disabled ? 0.45 : 1, overflow: 'visible' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
        <div testId="sidebar-session-open" tabIndex={disabled ? -1 : 0} {...activation} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ width: '100%', height: '100%', padding: 9, borderRadius: 8, display: 'flex', flexDirection: 'column', gap: 4, cursor: disabled ? 'default' : 'pointer' }}>
          <div style={{ minWidth: 0, height: 16, minHeight: 16, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingRight: actionsWidth }}>
            <Icon name="folder" size={13} color={metadataColor} />
            <text style={{ color: active ? colors.sidebarActiveMuted : colors.textMuted, fontSize: 10, lineHeight: 14, fontWeight: 500, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{projectName}</text>
          </div>
          <div testId={active ? 'sidebar-session-active' : 'sidebar-session-row'} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            {renaming ? (
              <input
                testId="sidebar-rename-input"
                value={draft}
                autoFocus
                theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }}
                style={{ width: '100%', height: 16, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 12, fontWeight: 500 }}
                onChange={(event) => setDraft(String(event.value ?? ''))}
                onKeyDown={(event) => {
                  if (event.key === 'enter') commitRename()
                  if (event.key === 'escape') setRenaming(false)
                }}
              />
            ) : (
              <text testId="sidebar-session-title" style={{ color: active ? colors.text : colors.textMuted, fontSize: 12, lineHeight: 16, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
            )}
            {session.branch ? <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 12 }}>
              <Icon name="gitBranch" size={11} color={metadataColor} />
              <text testId="sidebar-session-footer" style={{ color: metadataColor, fontSize: 9, lineHeight: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.branch}</text>
            </div> : null}
          </div>
        </div>
        <div style={{ position: 'absolute', top: 6, right: 6, height: 26, width: actionsWidth, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, opacity: showActions ? 1 : 0, pointerEvents: showActions ? 'auto' : 'none' }} onMouseEnter={() => setActionsHovered(true)} onMouseLeave={() => setActionsHovered(false)}>
          <>
            {showMore && (
              <div style={{ position: 'relative', display: 'flex', flexDirection: 'row' }}>
                <div testId="sidebar-more" tabIndex={disabled ? -1 : 0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onClick={() => { if (!disabled) onMore?.() }} onKeyDown={event => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onMore?.() }}>
                  <Icon name="moreHorizontal" size={12} color={metadataColor} />
                </div>
                {moreMounted && (
                  <ThreadMenu
                    open={moreOpen}
                    actions={actions}
                    onSelect={(id) => {
                      if (id === 'rename') {
                        setDraft(session.title)
                        setRenaming(true)
                        onMore?.()
                        return
                      }
                      onAction?.(id)
                    }}
                    onClose={() => onMore?.()}
                  />
                )}
              </div>
            )}
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'row' }}>
              <div testId="sidebar-snooze" tabIndex={disabled ? -1 : 0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onClick={() => { if (!disabled) onSnooze() }} onKeyDown={event => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onSnooze() }}>
                <Icon name="clock" size={12} color={metadataColor} />
              </div>
              {snoozeMounted && <SnoozeMenu open={snoozeOpen} onSchedule={onSchedule} onClose={onSnooze} />}
            </div>
            <div testId="sidebar-settle" tabIndex={disabled ? -1 : 0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ height: 26, minWidth: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingLeft: 3, paddingRight: 3, cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onMouseEnter={() => setSettleHovered(true)} onMouseLeave={() => setSettleHovered(false)} onClick={() => { if (!disabled) onSettle() }} onKeyDown={event => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onSettle() }}>
              <Icon name="check" size={11} color={settleHovered ? colors.text : metadataColor} />
              <text testId="sidebar-settle-label" style={{ color: settleHovered ? colors.text : metadataColor, fontSize: 9 }}>Settle</text>
            </div>
          </>
        </div>
        <div style={{ position: 'absolute', top: 6, right: 9, height: 26, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, opacity: showActions ? 0 : 1, pointerEvents: 'none' }}>
          {pinned && <div testId="sidebar-pinned"><Icon name="pin" size={10} color={metadataColor} /></div>}
          <text style={{ color: running ? colors.info : metadataColor, fontSize: 9 }}>{running ? 'Working' : relativeTime(session.modifiedAt)}</text>
          <text style={{ color: '#E9705A', fontSize: 10, fontWeight: 700 }}>π</text>
        </div>
      </div>
    </SessionRowInset>
  )
}

function ThreadMenu({ open, actions, onSelect, onClose }: { open: boolean; actions: ThreadAction[]; onSelect(id: ThreadActionId): void; onClose(): void }) {
  const windowSize = useWindowSize({ intervalMs: 100 })
  const escape = (event: { key?: string }) => { if (open && event.key === 'escape') onClose() }
  return (<>
    {open && <anchored position={{ x: 0, y: 0 }} deferred priority={7} occlude>
      <div testId="thread-menu-dismiss" autoFocus tabIndex={0} style={{ width: windowSize.width, height: windowSize.height, backgroundColor: colors.transparent }} onClick={onClose} onKeyDown={escape} />
    </anchored>}
    <anchored side="bottom" align="end" gap={5} fit="snap" snapMargin={8} deferred priority={8} occlude>
      <div testId="thread-menu-positioner" style={{ display: 'flex', backgroundColor: colors.sidebar, pointerEvents: open ? 'auto' : 'none' }}>
        <DropdownSurface testId="thread-menu" open={open} tabIndex={0} onKeyDown={escape} style={{ width: 248, padding: 5, borderRadius: 9 }}>
          {actions.map((action) => (
            <div
              key={action.id}
              testId={`thread-menu-${action.id}`}
              tabIndex={0}
              onKeyDown={event => {
                escape(event)
                if (open && !action.disabled && (event.key === 'enter' || event.key === 'space')) onSelect(action.id)
              }}
              style={{ minHeight: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 8, paddingRight: 8, borderRadius: 6, opacity: action.disabled ? 0.4 : 1, cursor: action.disabled ? 'default' : 'pointer', ...(action.disabled ? {} : { hover: { backgroundColor: colors.hover } }) }}
              onClick={() => { if (!action.disabled) onSelect(action.id) }}
            >
              <text style={{ color: action.danger ? colors.error : colors.textMuted, fontSize: 11 }}>{action.label}</text>
              <div style={{ flexGrow: 1 }} />
              {action.disabled && action.detail ? <text style={{ color: colors.textFaint, fontSize: 9 }}>{action.detail}</text> : null}
            </div>
          ))}
        </DropdownSurface>
      </div>
    </anchored>
  </>)
}

function SnoozeMenu({ open, onSchedule, onClose }: { open: boolean; onSchedule(until: number): void; onClose(): void }) {
  const windowSize = useWindowSize({ intervalMs: 100 })
  const escape = (event: { key?: string }) => { if (open && event.key === 'escape') onClose() }
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
  return (<>
    {open && <anchored position={{ x: 0, y: 0 }} deferred priority={7} occlude>
      <div testId="snooze-dismiss" autoFocus tabIndex={0} style={{ width: windowSize.width, height: windowSize.height, backgroundColor: colors.transparent }} onClick={onClose} onKeyDown={escape} />
    </anchored>}
    <anchored side="bottom" align="end" gap={5} fit="snap" snapMargin={8} deferred priority={8} occlude>
      <div testId="snooze-menu-positioner" style={{ display: 'flex', backgroundColor: colors.sidebar, pointerEvents: open ? 'auto' : 'none' }}>
        <DropdownSurface testId="snooze-menu" open={open} tabIndex={0} onKeyDown={escape} style={{ width: 204, padding: 5, borderRadius: 9 }}>
          {options.map((option, index) => (
            <React.Fragment key={option.label}>
              <div testId={`snooze-option-${index}`} tabIndex={0} onKeyDown={event => { escape(event); if (open && (event.key === 'enter' || event.key === 'space')) onSchedule(option.value) }} style={{ height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => onSchedule(option.value)}>
                <text style={{ color: colors.textMuted, fontSize: 11 }}>{option.label}</text>
                <div style={{ flexGrow: 1 }} />
                <text style={{ color: colors.textFaint, fontSize: 9 }}>{new Date(option.value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</text>
              </div>
            </React.Fragment>
          ))}
        </DropdownSurface>
      </div>
    </anchored>
  </>)
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
