import React from 'react'
import type { Notice, NoticeKind, WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { NativeVirtualList } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export function composerNotificationStackHeight(noticeCount: number): number {
  const visibleCount = Math.min(3, Math.max(0, noticeCount))
  return visibleCount === 0 ? 0 : 48 + (visibleCount - 1) * 18
}

export function ComposerNotificationStack({ notices, onClear }: { notices: Notice[]; onClear(): void }) {
  const visible = notices.slice(-3)
  if (visible.length === 0) return null

  return (
    <div testId="composer-notification-stack" style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'column', marginBottom: 8 }}>
      {visible.map((notice, index) => {
        const newest = index === visible.length - 1
        const depth = visible.length - index - 1
        return (
          <NotificationCard
            key={notice.id}
            notice={notice}
            newest={newest}
            depth={depth}
            stacked={index > 0}
            onClear={onClear}
          />
        )
      })}
    </div>
  )
}

function NotificationCard({ notice, newest, depth, stacked, onClear }: { notice: Notice; newest: boolean; depth: number; stacked: boolean; onClear(): void }) {
  const tone = noticeColor(notice.kind)
  const baseOpacity = newest ? 1 : depth === 1 ? 0.55 : 0.28
  return (
    <div
      testId={newest ? 'notification-toast' : 'notification-stack-item'}
      style={{
        height: 40,
        minHeight: 40,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: stacked ? -22 : 0,
        paddingTop: 8,
        paddingRight: 12,
        paddingBottom: 8,
        paddingLeft: 12,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: colors.popover,
        opacity: baseOpacity,
        overflow: 'hidden',
        selectionColor: '#4F67D866',
      }}
    >
      <div style={{ width: 18, height: 18, borderRadius: 9, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: `${tone}22`, flexShrink: 0 }}>
        <Icon name={notice.kind === 'error' ? 'x' : notice.kind === 'warning' ? 'bell' : 'check'} size={11} color={tone} />
      </div>
      <AutoScrollingNoticeText message={notice.message} {...(newest ? { testId: 'notification-toast-message', scrollTestId: 'notification-toast-scroll' } : {})} />
      <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontSans, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatDate(notice.createdAt)}</text>
      {newest && (
        <div testId="clear-notifications" tabIndex={0} style={{ height: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, paddingLeft: 6, paddingRight: 6, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover }, flexShrink: 0 }} onClick={onClear}>
          <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', pointerEvents: 'none' }}>Clear all</text>
          <div style={{ width: 10, height: 10, pointerEvents: 'none' }}><Icon name="x" size={10} color={colors.textFaint} /></div>
        </div>
      )}
    </div>
  )
}

export function NotificationLedgerView({ state, panelWidth = 422, onClear }: { state: WorkbenchState; panelWidth?: number; onClear(): void }) {
  const notices = [...state.notices].reverse()
  return (
    <div testId="notification-panel" style={{ width: panelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <div testId="notification-panel-header" style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 14 }}>
        <Icon name="bell" size={15} color={colors.textMuted} />
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Notifications</text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: colors.textFaint, fontSize: 10 }}>{`${notices.length} saved`}</text>
        {notices.length > 0 && (
          <div testId="clear-notification-ledger" tabIndex={0} style={{ height: 26, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 7, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClear}>
            <text style={{ color: colors.textMuted, fontSize: 10, pointerEvents: 'none' }}>Clear all</text>
          </div>
        )}
      </div>
      <NativeVirtualList testId="notification-list" alignment="top" estimatedItemHeight={52} overdraw={300} style={{ flexGrow: 1, minHeight: 0, width: '100%' }}>
        {notices.length === 0 ? (
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 180, gap: 9 }}>
            <div style={{ width: 38, height: 38, borderRadius: 19, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.card }}><Icon name="bell" size={18} color={colors.textFaint} /></div>
            <text style={{ color: colors.text, fontSize: 15, fontWeight: 600 }}>No notifications yet</text>
            <text style={{ color: colors.textFaint, fontSize: 11 }}>Pi and workbench events will be kept here.</text>
          </div>
        ) : notices.map((notice) => <LedgerRow key={notice.id} notice={notice} />)}
      </NativeVirtualList>
    </div>
  )
}

function LedgerRow({ notice }: { notice: Notice }) {
  const tone = noticeColor(notice.kind)
  return (
    <div testId="notification-ledger-row-frame" style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'row', paddingLeft: 14, paddingRight: 14, paddingTop: 4, paddingBottom: 4 }}>
      <div testId="notification-ledger-row" style={{ minWidth: 0, minHeight: 40, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingTop: 8, paddingRight: 12, paddingBottom: 8, paddingLeft: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card, selectionColor: '#4F67D866' }}>
        <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone, flexShrink: 0 }} />
        <AutoScrollingNoticeText message={notice.message} scrollTestId="notification-ledger-scroll" />
        <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontSans, whiteSpace: 'nowrap', flexShrink: 0 }}>{formatDate(notice.createdAt)}</text>
      </div>
    </div>
  )
}

function AutoScrollingNoticeText({ message, testId, scrollTestId }: { message: string; testId?: string; scrollTestId?: string }) {
  return (
    <div {...(scrollTestId ? { testId: scrollTestId } : {})} style={{ minWidth: 0, height: 18, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', overflow: 'hidden' }}>
      <text {...(testId ? { testId } : {})} style={{ minWidth: 0, color: colors.textMuted, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontSans }}>{message}</text>
    </div>
  )
}

function noticeColor(kind: NoticeKind): string {
  if (kind === 'error') return colors.error
  if (kind === 'warning') return colors.warning
  return colors.success
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
