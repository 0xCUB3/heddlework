import React, { useEffect, useRef, useState } from 'react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { Notice, NoticeKind, WorkbenchState } from '../workbench/state.ts'
import { Button, IconButton } from './primitives.tsx'
import { Icon } from './icons.tsx'
import { colors } from './theme.ts'

export const NOTIFICATION_TOAST_DURATION_MS = 2_000

export function NotificationToast({ notices, rightInset = 16 }: { notices: Notice[]; rightInset?: number }) {
  const [active, setActive] = useState<Notice | undefined>()
  const seen = useRef(new Set<number>())
  const latest = notices.at(-1)

  useEffect(() => {
    if (!latest || seen.current.has(latest.id)) return
    seen.current.add(latest.id)
    setActive(latest)
    const timer = setTimeout(() => {
      setActive((current) => current?.id === latest.id ? undefined : current)
    }, NOTIFICATION_TOAST_DURATION_MS)
    return () => clearTimeout(timer)
  }, [latest])

  if (!active) return null
  const tone = noticeColor(active.kind)
  return (
    <div
      testId="notification-toast"
      style={{ position: 'absolute', top: 62, right: rightInset, width: 344, minHeight: 76, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 10, padding: 13, paddingRight: 9, borderRadius: 11, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'hidden' }}
    >
      <div style={{ width: 20, height: 20, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: `${tone}22`, flexShrink: 0 }}>
        <Icon name={active.kind === 'error' ? 'x' : active.kind === 'warning' ? 'bell' : 'check'} size={12} color={tone} />
      </div>
      <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 650 }}>{noticeTitle(active.kind)}</text>
        <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17, whiteSpace: 'normal', lineClamp: 3 }}>{active.message}</text>
      </div>
      <div testId="dismiss-toast" tabIndex={0} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, cursor: 'pointer', hover: { backgroundColor: colors.hover }, flexShrink: 0 }} onClick={() => setActive(undefined)}>
        <Icon name="x" size={12} color={colors.textFaint} />
      </div>
    </div>
  )
}

export function NotificationLedgerView({ state, controller, onClose }: { state: WorkbenchState; controller: WorkbenchController; onClose(): void }) {
  const notices = [...state.notices].reverse()
  return (
    <div testId="notification-panel" style={{ width: 422, flexShrink: 0, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 12 }}>
        <Icon name="bell" size={15} color={colors.textMuted} />
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Notifications</text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: colors.textFaint, fontSize: 10 }}>{`${notices.length} saved`}</text>
        <Button label="Clear all" compact disabled={notices.length === 0} onClick={() => controller.clearNotices()} />
        <IconButton icon="x" label="Close notifications" testId="close-notifications" onClick={onClose} />
      </div>
      <virtual-list alignment="top" estimatedItemHeight={78} overdraw={300} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {notices.length === 0 ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 180, gap: 9 }}>
            <div style={{ width: 38, height: 38, borderRadius: 19, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card }}><Icon name="bell" size={18} color={colors.textFaint} /></div>
            <text style={{ color: colors.text, fontSize: 15, fontWeight: 600 }}>No notifications yet</text>
            <text style={{ color: colors.textFaint, fontSize: 11 }}>Pi and workbench events will be kept here.</text>
          </div>
        ) : notices.map((notice) => <LedgerRow key={notice.id} notice={notice} controller={controller} />)}
      </virtual-list>
    </div>
  )
}

function LedgerRow({ notice, controller }: { notice: Notice; controller: WorkbenchController }) {
  const tone = noticeColor(notice.kind)
  return (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', paddingLeft: 14, paddingRight: 14, paddingTop: 5, paddingBottom: 5 }}>
      <div style={{ width: '100%', minHeight: 68, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 11, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, marginTop: 5, backgroundColor: tone, flexShrink: 0 }} />
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <text style={{ color: colors.text, fontSize: 11, fontWeight: 650 }}>{noticeTitle(notice.kind)}</text>
            <div style={{ flexGrow: 1 }} />
            <text style={{ color: colors.textFaint, fontSize: 9 }}>{formatDate(notice.createdAt)}</text>
          </div>
          <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17, whiteSpace: 'normal' }}>{notice.message}</text>
        </div>
        <div tabIndex={0} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover }, flexShrink: 0 }} onClick={() => controller.dismissNotice(notice.id)}>
          <Icon name="x" size={12} color={colors.textFaint} />
        </div>
      </div>
    </div>
  )
}

function noticeTitle(kind: NoticeKind): string {
  if (kind === 'error') return 'Action failed'
  if (kind === 'warning') return 'Attention needed'
  return 'Workbench update'
}

function noticeColor(kind: NoticeKind): string {
  if (kind === 'error') return colors.error
  if (kind === 'warning') return colors.warning
  return colors.success
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
