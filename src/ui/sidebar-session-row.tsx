import React, { useState } from 'react'
import { useWindowSize } from '@gpuix/react'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { ThreadLifecycle } from '../workbench/state.ts'
import { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket } from '../workbench/thread-lifecycle.ts'
import { DropdownSurface, useDropdownPresence } from './dropdown.tsx'
import { Icon } from './icons.tsx'
import { useResponsiveLayout } from './responsive.tsx'
import { colors } from './theme.ts'

const SIDEBAR_BORDER_WIDTH = 1
const SESSION_ROW_INSET = 8

export { SESSION_SETTLED_AFTER_MS, sessionLifecycleBucket }

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
  onClick,
  onSettle,
  onWake,
  onSnooze,
  onSchedule,
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
  onClick(): void
  onSettle(): void
  onWake(): void
  onSnooze(): void
  onSchedule(until: number): void
}) {
  const { compact } = useResponsiveLayout()
  const height = session.branch ? 74 : 56
  const activation = disabled ? {} : {
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
  const showActions = compact || hovered || actionsHovered || focused || snoozeMounted
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
          <div style={{ minWidth: 0, height: 16, minHeight: 16, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingRight: 78 }}>
            <Icon name="folder" size={13} color={colors.textFaint} />
            <text style={{ color: colors.textMuted, fontSize: 10, lineHeight: 14, fontWeight: 550, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{projectName}</text>
          </div>
          <div testId={active ? 'sidebar-session-active' : 'sidebar-session-row'} style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 12, lineHeight: 16, fontWeight: active ? 600 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.title}</text>
            {session.branch ? <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 12 }}>
              <Icon name="gitBranch" size={11} color={colors.textFaint} />
              <text testId="sidebar-session-footer" style={{ color: colors.textFaint, fontSize: 9, lineHeight: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{session.branch}</text>
            </div> : null}
          </div>
        </div>
        <div style={{ position: 'absolute', top: 6, right: 6, height: 26, width: 78, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, opacity: showActions ? 1 : 0, pointerEvents: showActions ? 'auto' : 'none' }} onMouseEnter={() => setActionsHovered(true)} onMouseLeave={() => setActionsHovered(false)}>
          <>
            <div style={{ position: 'relative', display: 'flex', flexDirection: 'row' }}>
              <div testId="sidebar-snooze" tabIndex={disabled ? -1 : 0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onClick={() => { if (!disabled) onSnooze() }} onKeyDown={event => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onSnooze() }}>
                <Icon name="clock" size={12} color={colors.textFaint} />
              </div>
              {snoozeMounted && <SnoozeMenu open={snoozeOpen} onSchedule={onSchedule} onClose={onSnooze} />}
            </div>
            <div testId="sidebar-settle" tabIndex={disabled ? -1 : 0} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ height: 26, minWidth: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3, paddingLeft: 3, paddingRight: 3, cursor: 'pointer', borderRadius: 5, hover: { backgroundColor: colors.hover } }} onMouseEnter={() => setSettleHovered(true)} onMouseLeave={() => setSettleHovered(false)} onClick={() => { if (!disabled) onSettle() }} onKeyDown={event => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onSettle() }}>
              <Icon name="check" size={11} color={settleHovered ? colors.text : colors.textFaint} />
              <text testId="sidebar-settle-label" style={{ color: settleHovered ? colors.text : colors.textFaint, fontSize: 9 }}>Settle</text>
            </div>
          </>
        </div>
        <div style={{ position: 'absolute', top: 6, right: 9, height: 26, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, opacity: showActions ? 0 : 1, pointerEvents: 'none' }}>
          <text style={{ color: running ? colors.info : colors.textFaint, fontSize: 9 }}>{running ? 'Working' : relativeTime(session.modifiedAt)}</text>
          <text style={{ color: '#E9705A', fontSize: 10, fontWeight: 700 }}>π</text>
        </div>
      </div>
    </SessionRowInset>
  )
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
