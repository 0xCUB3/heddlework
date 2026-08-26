import React, { useEffect, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { Notice, NoticeKind, WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { NativeVirtualList } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export const NOTIFICATION_STACK_FADE_MS = 2_200
export const NOTIFICATION_DISMISS_MS = 180
export const NOTIFICATION_TOAST_DURATION_MS = NOTIFICATION_STACK_FADE_MS

export function ComposerNotificationStack({ notices }: { notices: Notice[] }) {
  const [visibleIds, setVisibleIds] = useState<number[]>([])
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(() => new Set())
  const [dismissal, setDismissal] = useState<{ id: number; progress: number } | null>(null)
  const latest = notices.at(-1)

  useEffect(() => {
    if (!latest || dismissedIds.has(latest.id)) return
    setVisibleIds((current) => [...current.filter((id) => id !== latest.id && !dismissedIds.has(id)), latest.id].slice(-3))
    const timer = setTimeout(() => setVisibleIds((current) => current.includes(latest.id) ? [latest.id] : current), NOTIFICATION_STACK_FADE_MS)
    return () => clearTimeout(timer)
  }, [dismissedIds, latest])

  useEffect(() => {
    if (!dismissal) return
    const startedAt = Date.now() - dismissal.progress * NOTIFICATION_DISMISS_MS
    const timer = setInterval(() => {
      const progress = Math.min(1, (Date.now() - startedAt) / NOTIFICATION_DISMISS_MS)
      if (progress < 1) {
        setDismissal((current) => current?.id === dismissal.id ? { id: dismissal.id, progress } : current)
        return
      }
      clearInterval(timer)
      setVisibleIds((current) => current.filter((id) => id !== dismissal.id))
      setDismissedIds((current) => new Set(current).add(dismissal.id))
      setDismissal(null)
    }, 16)
    return () => clearInterval(timer)
  }, [dismissal?.id])

  const visible = visibleIds
    .map((id) => notices.find((notice) => notice.id === id))
    .filter((notice): notice is Notice => Boolean(notice))
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
            dismissProgress={dismissal?.id === notice.id ? dismissal.progress : 0}
            onDismiss={() => setDismissal((current) => current ?? { id: notice.id, progress: 0 })}
          />
        )
      })}
    </div>
  )
}

function NotificationCard({ notice, newest, depth, stacked, dismissProgress, onDismiss }: { notice: Notice; newest: boolean; depth: number; stacked: boolean; dismissProgress: number; onDismiss(): void }) {
  const tone = noticeColor(notice.kind)
  const easedDismiss = 1 - (1 - dismissProgress) ** 3
  const remaining = 1 - easedDismiss
  const baseOpacity = newest ? 1 : depth === 1 ? 0.55 : 0.28
  return (
    <div
      testId={newest ? 'notification-toast' : 'notification-stack-item'}
      style={{
        height: 40 * remaining,
        minHeight: 40 * remaining,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        marginTop: stacked ? -22 * remaining : 0,
        paddingTop: 8 * remaining,
        paddingRight: 12,
        paddingBottom: 8 * remaining,
        paddingLeft: 12,
        borderRadius: 11,
        borderWidth: 1,
        borderColor: colors.borderStrong,
        backgroundColor: colors.popover,
        opacity: baseOpacity * remaining,
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
        <div testId="dismiss-toast" tabIndex={0} style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover }, flexShrink: 0 }} onClick={onDismiss}>
          <Icon name="x" size={12} color={colors.textFaint} />
        </div>
      )}
    </div>
  )
}

export function NotificationLedgerView({ state, panelWidth = 422 }: { state: WorkbenchState; panelWidth?: number }) {
  const notices = [...state.notices].reverse()
  return (
    <div testId="notification-panel" style={{ width: panelWidth, flexShrink: 0, display: 'flex', flexDirection: 'column', minWidth: 0, height: '100%', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <div testId="notification-panel-header" style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 14, paddingRight: 14 }}>
        <Icon name="bell" size={15} color={colors.textMuted} />
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Notifications</text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: colors.textFaint, fontSize: 10 }}>{`${notices.length} saved`}</text>
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
  const renderer = useGpuixRequired()
  const viewportIdRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    const elementId = viewportIdRef.current
    const scrollTo = renderer.scrollTo?.bind(renderer)
    const getScrollOffset = renderer.getScrollOffset?.bind(renderer)
    if (elementId === undefined || !scrollTo) return

    let interval: ReturnType<typeof setInterval> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancelled = false
    const stopInterval = () => {
      if (interval) clearInterval(interval)
      interval = undefined
    }
    const startScrolling = () => {
      let requestedOffset = 0
      let lastOffset = 0
      let unchangedFrames = 0
      let steps = 0
      let moved = false
      interval = setInterval(() => {
        requestedOffset -= 2
        scrollTo(elementId, requestedOffset, 0)
        const actualOffset = getScrollOffset?.(elementId)?.[0]
        if (actualOffset !== undefined) {
          if (actualOffset < -0.5) moved = true
          unchangedFrames = Math.abs(actualOffset - lastOffset) < 0.01 ? unchangedFrames + 1 : 0
          lastOffset = actualOffset
        }
        steps += 1
        if ((steps >= 12 && unchangedFrames >= 4) || steps >= 2_000) {
          stopInterval()
          if (!moved || cancelled) return
          timer = setTimeout(() => {
            scrollTo(elementId, 0, 0)
            timer = setTimeout(startScrolling, 1_800)
          }, 1_400)
        }
      }, 20)
    }

    scrollTo(elementId, 0, 0)
    timer = setTimeout(startScrolling, 700)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      stopInterval()
    }
  }, [message, renderer])

  return (
    <div ref={(element) => { viewportIdRef.current = element?.id }} {...(scrollTestId ? { testId: scrollTestId } : {})} style={{ minWidth: 0, height: 18, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', overflowX: 'scroll', overflowY: 'hidden' }}>
      <text {...(testId ? { testId } : {})} style={{ color: colors.textMuted, fontSize: 11, whiteSpace: 'nowrap', flexShrink: 0, fontFamily: nativeTheme.fontSans }}>{message}</text>
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
