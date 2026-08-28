import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import type { StyleDesc } from '@gpuix/react'
import type { PiImageContent } from '../pi/types.ts'
import type { WorkbenchState, ToolRun } from '../workbench/state.ts'
import { buildTimeline, type TimelineItem } from '../workbench/timeline.ts'
import { Icon, type IconName } from './icons.tsx'
import { colors, nativeTheme } from './theme.ts'
import { openExternal } from './open-external.ts'
import { formatElapsedSeconds } from './duration.ts'
import { copyTextToClipboard, hydrateMessageImages } from './clipboard-media.ts'
import { NativeVirtualList, type NativeScrollEvent, type NativeVisibleRangeEvent } from './primitives.tsx'
import { composerNotificationStackHeight } from './notifications.tsx'
import { questionnaireWaitingDockReserveHeight } from './composer.tsx'
import { queueDockReserveHeight } from './queue-dock.tsx'
import { resolveToolPresentation, type FabricAuditPresentation, type FabricToolPresentation, type ToolPresenter } from './tool-presenters.ts'
import {
  groupWorkItems,
  projectTranscriptRows,
  type DisplayTimelineItem,
  type TraceTimelineItem,
  type TranscriptProjectionRow,
} from './transcript-projection.ts'

const MAX_TOOL_OUTPUT = 24_000
const HISTORY_PREFETCH_ROWS = 8
const MAX_HISTORY_NO_PROGRESS_PAGES = 8
const TRACE_INITIAL_PROJECTED_ROWS = 48
const TRACE_PROJECTION_CHUNK_ROWS = 48
const TRACE_PROJECTION_FRAME_MS = 16
const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 88
function codeSurfaceStyle(): StyleDesc {
  return {
    width: '100%',
    paddingTop: 10,
    paddingRight: 12,
    paddingBottom: 10,
    paddingLeft: 12,
    borderRadius: 9,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.code,
  }
}

function traceMarkdownTheme() {
  return {
    ...nativeTheme,
    text: colors.textMuted,
    textMuted: colors.textMuted,
    metrics: {
      ...nativeTheme.metrics,
      mdTextSize: 12,
      mdLineHeight: 19,
      mdBlockGap: 7,
      mdHeadingSizes: [12, 12, 12, 12],
      mdHeadingLineHeights: [19, 19, 19, 19],
      codeTextSize: 11,
      codeLineHeight: 18,
    },
  }
}

const FABRIC_COLLAPSED_CALL_LIMIT = 8

type TranscriptRenderRow = TranscriptProjectionRow
  | { id: 'empty-conversation'; kind: 'empty-conversation' }
  | { id: 'working'; kind: 'working' }
  | { id: 'composer-spacer'; kind: 'composer-spacer' }

interface TranscriptDisclosureState {
  sessionKey: string
  traces: Set<string>
  entries: Set<string>
  traceLimits: Map<string, number>
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const EMPTY_LIMITS: ReadonlyMap<string, number> = new Map()

export const Transcript = memo(function Transcript({
  state,
  presenters,
  onOpenDiff,
  onRevert,
  onLoadEarlier,
}: {
  state: WorkbenchState
  presenters: ReadonlyMap<string, ToolPresenter>
  onOpenDiff(): void
  onRevert(entryId: string): void
  onLoadEarlier?(): void | Promise<void>
}) {
  const paging = useRef(false)
  const visibleStartIndex = useRef<number | undefined>(undefined)
  const historyDemandDirection = useRef<'older' | 'newer'>('older')
  const pendingHistoryPage = useRef<{ anchorId: string | undefined; continuation: number } | undefined>(undefined)
  const sessionKey = state.session.sessionFile ?? state.session.sessionId ?? state.workspacePath
  const [disclosures, setDisclosures] = useState<TranscriptDisclosureState>(() => ({ sessionKey, traces: new Set(), entries: new Set(), traceLimits: new Map() }))
  const expandedTraceIds = disclosures.sessionKey === sessionKey ? disclosures.traces : EMPTY_IDS
  const expandedEntryIds = disclosures.sessionKey === sessionKey ? disclosures.entries : EMPTY_IDS
  const traceLimits = disclosures.sessionKey === sessionKey ? disclosures.traceLimits : EMPTY_LIMITS

  useEffect(() => {
    if (!state.messagesLoadingEarlier) paging.current = false
  }, [sessionKey, state.messages.length, state.messagesLoadingEarlier])
  useEffect(() => {
    paging.current = false
    pendingHistoryPage.current = undefined
    visibleStartIndex.current = undefined
    historyDemandDirection.current = 'older'
  }, [sessionKey])

  const hydratedMessages = useMemo(() => hydrateMessageImages(state.messages), [state.messages])
  const items = useMemo(
    () => groupWorkItems(buildTimeline(hydratedMessages, state.liveAssistant, state.liveTools, state.forkMessages)),
    [hydratedMessages, state.forkMessages, state.liveAssistant, state.liveTools],
  )
  const traceLengths = useMemo(() => new Map(items.flatMap((item) => item.kind === 'work-trace' ? [[item.id, item.items.length] as const] : [])), [items])
  const projectedRows = useMemo(() => projectTranscriptRows(items, expandedTraceIds, traceLimits), [expandedTraceIds, items, traceLimits])
  const hasActiveTrace = items.some((item) => item.kind === 'work-trace' && item.items.some((entry) => entry.kind === 'thinking' ? entry.streaming : entry.kind === 'tool' ? entry.tool.status !== 'complete' : false))
  const rows = useMemo<TranscriptRenderRow[]>(() => {
    const next: TranscriptRenderRow[] = projectedRows.length > 0 ? [...projectedRows] : [{ id: 'empty-conversation', kind: 'empty-conversation' }]
    if (state.session.isStreaming && !hasActiveTrace) next.push({ id: 'working', kind: 'working' })
    next.push({ id: 'composer-spacer', kind: 'composer-spacer' })
    return next
  }, [hasActiveTrace, projectedRows, state.session.isStreaming])
  const rowIndexById = useMemo(() => new Map(rows.map((row, index) => [row.id, index])), [rows])
  // Spread retained-tree growth across frames; native virtualization handles layout and paint per direct row.
  useEffect(() => {
    if (disclosures.sessionKey !== sessionKey) return
    const hasPendingRows = [...disclosures.traces].some((traceId) => (disclosures.traceLimits.get(traceId) ?? 0) < (traceLengths.get(traceId) ?? 0))
    if (!hasPendingRows) return
    const timer = setTimeout(() => {
      setDisclosures((current) => {
        if (current.sessionKey !== sessionKey) return current
        const traceLimits = new Map(current.traceLimits)
        let selected: { id: string; length: number; limit: number } | undefined
        for (const traceId of current.traces) {
          const length = traceLengths.get(traceId) ?? 0
          const limit = traceLimits.get(traceId) ?? Math.min(TRACE_INITIAL_PROJECTED_ROWS, length)
          if (limit >= length || (selected && selected.limit <= limit)) continue
          selected = { id: traceId, length, limit }
        }
        if (!selected) return current
        traceLimits.set(selected.id, Math.min(selected.length, selected.limit + TRACE_PROJECTION_CHUNK_ROWS))
        return { ...current, traceLimits }
      })
    }, TRACE_PROJECTION_FRAME_MS)
    return () => clearTimeout(timer)
  }, [disclosures, sessionKey, traceLengths])
  const loadEarlier = (continuation = 0) => {
    if (historyDemandDirection.current !== 'older' || !onLoadEarlier || !state.messagesHasOlder || state.messagesLoadingEarlier || paging.current) return
    paging.current = true
    pendingHistoryPage.current = { anchorId: rows[0]?.id, continuation }
    try {
      const request = onLoadEarlier()
      if (request) {
        void request.then(() => { paging.current = false }, () => {
          paging.current = false
          pendingHistoryPage.current = undefined
        })
      } else {
        paging.current = false
      }
    } catch {
      paging.current = false
      pendingHistoryPage.current = undefined
    }
  }
  const handleVisibleRange = (event: NativeVisibleRangeEvent) => {
    if (typeof event.startIndex !== 'number') return
    const firstVisible = Math.max(0, Math.floor(event.startIndex))
    visibleStartIndex.current = firstVisible
    if (firstVisible <= HISTORY_PREFETCH_ROWS) loadEarlier()
  }
  // Downward intent owns the viewport and cancels every queued hidden-page continuation.
  const handleHistoryScroll = (event: NativeScrollEvent) => {
    if (typeof event.deltaY !== 'number' || event.deltaY === 0) return
    if (event.deltaY < 0) {
      historyDemandDirection.current = 'newer'
      pendingHistoryPage.current = undefined
      return
    }
    historyDemandDirection.current = 'older'
    if ((visibleStartIndex.current ?? HISTORY_PREFETCH_ROWS + 1) <= HISTORY_PREFETCH_ROWS) loadEarlier()
  }

  // A disk page can fold entirely into the collapsed first trace and add no scrollable row.
  useEffect(() => {
    if (state.messagesLoadingEarlier) return
    const pending = pendingHistoryPage.current
    if (!pending) return
    pendingHistoryPage.current = undefined
    const anchorIndex = pending.anchorId ? rowIndexById.get(pending.anchorId) ?? -1 : -1
    if (
      anchorIndex === 0
      && state.messagesHasOlder
      && (visibleStartIndex.current ?? HISTORY_PREFETCH_ROWS + 1) <= HISTORY_PREFETCH_ROWS
      && pending.continuation + 1 < MAX_HISTORY_NO_PROGRESS_PAGES
    ) {
      queueMicrotask(() => loadEarlier(pending.continuation + 1))
    }
  }, [rowIndexById, state.messagesHasOlder, state.messagesLoadingEarlier])

  const toggleTrace = (traceId: string) => {
    setDisclosures((current) => {
      const traces = new Set(current.sessionKey === sessionKey ? current.traces : EMPTY_IDS)
      if (traces.has(traceId)) traces.delete(traceId)
      else traces.add(traceId)
      const traceLimits = new Map(current.sessionKey === sessionKey ? current.traceLimits : EMPTY_LIMITS)
      if (traces.has(traceId)) traceLimits.set(traceId, Math.min(TRACE_INITIAL_PROJECTED_ROWS, traceLengths.get(traceId) ?? 0))
      else traceLimits.delete(traceId)
      return { sessionKey, traces, entries: new Set(current.sessionKey === sessionKey ? current.entries : EMPTY_IDS), traceLimits }
    })
  }
  const toggleEntry = (rowId: string) => {
    setDisclosures((current) => {
      const entries = new Set(current.sessionKey === sessionKey ? current.entries : EMPTY_IDS)
      if (entries.has(rowId)) entries.delete(rowId)
      else entries.add(rowId)
      return { sessionKey, traces: new Set(current.sessionKey === sessionKey ? current.traces : EMPTY_IDS), entries, traceLimits: new Map(current.sessionKey === sessionKey ? current.traceLimits : EMPTY_LIMITS) }
    })
  }

  // Direct keyed children preserve measured prepend anchors; each expanded entry is its own native virtual row.
  return (
    <div testId="transcript-scroll-surface" style={{ position: 'relative', flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column' }} onScroll={handleHistoryScroll}>
      <NativeVirtualList
        key={`${sessionKey}:virtual`}
        testId="transcript-list"
        alignment="bottom"
        followTail={state.session.isStreaming}
        onVisibleRange={handleVisibleRange}
        overdraw={240}
        estimatedItemHeight={TRANSCRIPT_ESTIMATED_ROW_HEIGHT}
        style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
      >
        {rows.map((row) => (
          <ProjectedTranscriptRow
            key={row.id}
            row={row}
            presenters={presenters}
            workspacePath={state.workspacePath}
            historyHasOlder={state.messagesHasOlder}
            activity={state.activity}
            noticeCount={state.notices.length}
            questionnaireCollapsed={state.questionnaireCollapsed !== undefined}
            queue={state.queue}
            expanded={row.kind === 'trace-header' ? expandedTraceIds.has(row.id) : expandedEntryIds.has(row.id)}
            onToggleTrace={toggleTrace}
            onToggleEntry={toggleEntry}
            onOpenDiff={onOpenDiff}
            onRevert={onRevert}
          />
        ))}
      </NativeVirtualList>
    </div>
  )
}, (previous, next) => previous.presenters === next.presenters
  && previous.state.messages === next.state.messages
  && previous.state.messagesHasOlder === next.state.messagesHasOlder
  && previous.state.messagesLoadingEarlier === next.state.messagesLoadingEarlier
  && previous.state.forkMessages === next.state.forkMessages
  && previous.state.liveAssistant === next.state.liveAssistant
  && previous.state.liveTools === next.state.liveTools
  && previous.state.activity === next.state.activity
  && previous.state.workspacePath === next.state.workspacePath
  && previous.state.session.sessionFile === next.state.session.sessionFile
  && previous.state.session.sessionId === next.state.session.sessionId
  && previous.state.session.isStreaming === next.state.session.isStreaming
  && previous.state.notices.length === next.state.notices.length
  && previous.state.questionnaireCollapsed === next.state.questionnaireCollapsed
  && previous.state.queue === next.state.queue)

function ProjectedTranscriptRow({
  row,
  presenters,
  workspacePath,
  historyHasOlder,
  activity,
  noticeCount,
  questionnaireCollapsed,
  queue,
  expanded,
  onToggleTrace,
  onToggleEntry,
  onOpenDiff,
  onRevert,
}: {
  row: TranscriptRenderRow
  presenters: ReadonlyMap<string, ToolPresenter>
  workspacePath: string
  historyHasOlder: boolean
  activity: string
  noticeCount: number
  questionnaireCollapsed: boolean
  queue: WorkbenchState['queue']
  expanded: boolean
  onToggleTrace(traceId: string): void
  onToggleEntry(rowId: string): void
  onOpenDiff(): void
  onRevert(entryId: string): void
}) {
  if (row.kind === 'empty-conversation') return <EmptyConversation workspacePath={workspacePath} />
  if (row.kind === 'working') return <WorkingRow activity={activity} />
  if (row.kind === 'composer-spacer') return <ComposerSpacer noticeCount={noticeCount} questionnaireCollapsed={questionnaireCollapsed} queue={queue} />
  if (row.kind === 'timeline-item') return <TimelineItemRow item={row.item} onRevert={onRevert} />
  if (row.kind === 'trace-header') {
    return (
      <TranscriptRowShell>
        <ExecutionTraceHeader trace={row.trace} expanded={expanded} durationKnown={Boolean(row.trace.boundaryId) || !historyHasOlder} onToggle={() => onToggleTrace(row.id)} />
      </TranscriptRowShell>
    )
  }
  if (row.kind === 'trace-files') {
    return (
      <TranscriptRowShell compact>
        <div style={{ marginLeft: 26 }}><ChangedFilesCard paths={row.paths} onOpenDiff={onOpenDiff} /></div>
      </TranscriptRowShell>
    )
  }
  if (row.kind === 'trace-continuation') {
    return (
      <TranscriptRowShell compact>
        <div testId="trace-projection-continuation" style={{ minHeight: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, marginLeft: 8, paddingLeft: 18, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
          <Icon name="circle" size={10} color={colors.textFaint} />
          <text style={{ color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`Preparing ${row.remaining} more ${row.remaining === 1 ? 'entry' : 'entries'}…`}</text>
        </div>
      </TranscriptRowShell>
    )
  }
  return (
    <TranscriptRowShell compact>
      <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', marginLeft: 8, paddingLeft: 18, paddingTop: 4, paddingBottom: 5, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
        {row.item.kind === 'thinking'
          ? <TraceReasoning item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
          : row.item.kind === 'context-injection'
            ? <TraceContextInjection item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
            : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650 }}>TOOL CALL</text><ToolRow item={row.item} presenters={presenters} expanded={expanded} onToggle={() => onToggleEntry(row.id)} onRevert={onRevert} /></div>}
      </div>
    </TranscriptRowShell>
  )
}

function TimelineItemRow({ item, onRevert }: { item: Exclude<DisplayTimelineItem, { kind: 'work-trace' }>; onRevert(entryId: string): void }) {
  return (
    <TranscriptRowShell user={item.kind === 'user'}>
      {item.kind === 'user' && <UserMessage item={item} onRevert={onRevert} />}
      {item.kind === 'assistant' && <AssistantMessage item={item} onRevert={onRevert} />}
      {item.kind === 'status' && <StatusMessage text={item.text} error={item.tone === 'error'} timestamp={item.timestamp} />}
    </TranscriptRowShell>
  )
}

function TranscriptRowShell({ children, user = false, compact = false }: { children: React.ReactNode; user?: boolean; compact?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingTop: user ? 9 : compact ? 0 : 4, paddingBottom: user ? 11 : compact ? 0 : 7, paddingLeft: 20, paddingRight: 20 }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, minWidth: 0 }}>{children}</div>
    </div>
  )
}

// Pointer-only visuals stay native: React hover revisions make GPUI remeasure rows beneath a stationary cursor.
function UserMessage({ item, onRevert }: { item: Extract<DisplayTimelineItem, { kind: 'user' }>; onRevert(entryId: string): void }) {
  return (
    <div testId="user-message" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%', gap: 6 }}>
      {item.images.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, maxWidth: '80%' }}>
          {item.images.map((image, index) => <MessageImage key={`${item.id}-image-${index}`} image={image} />)}
        </div>
      )}
      {item.text && (
        <div style={{ maxWidth: '80%', paddingTop: 10, paddingBottom: 10, paddingLeft: 13, paddingRight: 13, borderRadius: 16, backgroundColor: colors.message }}>
          <text style={{ color: colors.text, fontSize: 14, lineHeight: 21, whiteSpace: 'normal' }}>{item.text}</text>
        </div>
      )}
      <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} align="end" onRevert={onRevert} />
    </div>
  )
}

function AssistantMessage({ item, onRevert }: { item: Extract<DisplayTimelineItem, { kind: 'assistant' }>; onRevert(entryId: string): void }) {
  return (
    <div testId="assistant-message" style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 5, paddingLeft: 4, paddingRight: 4 }}>
      <markdown
        source={item.text || '…'}
        theme={nativeTheme}
        style={{ width: '100%', minWidth: 0 }}
        onLinkClick={(event) => openExternal(String(event.value ?? ''))}
      />
      {item.streaming
        ? <text style={{ color: colors.textFaint, fontSize: 10 }}>streaming</text>
        : <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} align="start" onRevert={onRevert} />}
    </div>
  )
}

function ExecutionTraceHeader({ trace, expanded, durationKnown, onToggle }: { trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }>; expanded: boolean; durationKnown: boolean; onToggle(): void }) {
  const running = trace.items.some((item) => item.kind === 'thinking' ? item.streaming : item.kind === 'tool' ? item.tool.status !== 'complete' : false)
  const duration = durationKnown ? traceDuration(trace.items) : undefined
  const preview = trace.items.at(-1)
  return (
    <div testId="execution-trace" style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 5, paddingLeft: 4, paddingRight: 2 }}>
      <div
        testId="tool-row"
        tabIndex={0}
        style={{ minHeight: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer' }}
        onClick={onToggle}
        onKeyDown={(event) => { if (event.key === 'enter') onToggle() }}
      >
        <text testId="execution-trace-label" style={{ color: colors.textMuted, fontSize: 13 }}>{running ? 'Working' : duration ? `Worked for ${duration}` : 'Worked'}</text>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={colors.textFaint} />
      </div>
      {!expanded && running && preview && <TracePreview item={preview} />}
    </div>
  )
}

function TraceReasoning({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'thinking' }>; expanded: boolean; onToggle(): void }) {
  return <TraceDisclosure label="REASONING" text={item.text} testId="trace-reasoning" streaming={Boolean(item.streaming)} expanded={expanded} onToggle={onToggle} />
}

function TraceContextInjection({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'context-injection' }>; expanded: boolean; onToggle(): void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <TraceDisclosure label="CONTEXT INJECTION" text={item.text || `${item.images.length} image${item.images.length === 1 ? '' : 's'}`} testId="trace-context-injection" expanded={expanded} onToggle={onToggle} />
      {expanded && item.source && <text style={{ color: colors.textFaint, fontSize: 9 }}>{`Source: ${item.source}`}</text>}
      {expanded && item.images.length > 0 && (
        <div testId="context-injection-images" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {item.images.map((image, index) => React.createElement('img', {
            key: `${item.id}-image-${index}`,
            src: image.previewPath ?? `data:${image.mimeType};base64,${image.data}`,
            alt: `${item.source ?? 'Extension'} image ${index + 1}`,
            objectFit: 'contain',
            style: { maxWidth: 320, maxHeight: 220, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
          } as never))}
        </div>
      )}
    </div>
  )
}

function TraceDisclosure({ label, text, testId, streaming = false, expanded, onToggle }: { label: string; text: string; testId: string; streaming?: boolean; expanded: boolean; onToggle(): void }) {
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div testId={`${testId}-toggle`} tabIndex={0} style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer' }} onClick={onToggle} onKeyDown={(event) => { if (event.key === 'enter') onToggle() }}>
        <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650, whiteSpace: 'nowrap', hover: { color: colors.textMuted } }}>{label}</text>
        {!expanded && <text testId={`${testId}-preview`} style={{ minWidth: 0, flexGrow: 1, color: colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(text)}</text>}
        {streaming && <text style={{ color: colors.info, fontSize: 9 }}>LIVE</text>}
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={10} color={colors.textFaint} />
      </div>
      {expanded && (
        <markdown
          testId={`${testId}-markdown`}
          source={text}
          theme={traceMarkdownTheme()}
          style={{ width: '100%', minWidth: 0 }}
          onLinkClick={(event) => openExternal(String(event.value ?? ''))}
        />
      )}
    </div>
  )
}

function TracePreview({ item }: { item: TraceTimelineItem }) {
  if (item.kind === 'thinking' || item.kind === 'context-injection') {
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(item.text)}</text></div>
  }
  const content = item.tool.output?.trim().split('\n').at(-1)
  return (
    <div testId="execution-preview" style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 1 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}><Icon name={toolIcon(item.tool.name)} size={13} color={colors.info} /><text style={{ color: colors.textMuted, fontSize: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{toolSummary(item.tool)}</text></div>
      {content && <text style={{ color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{content}</text>}
    </div>
  )
}

function ToolRow({ item, presenters, expanded, onToggle, onRevert }: { item: Extract<TimelineItem, { kind: 'tool' }>; presenters: ReadonlyMap<string, ToolPresenter>; expanded: boolean; onToggle(): void; onRevert(entryId: string): void }) {
  const tool = item.tool
  const presentation = resolveToolPresentation(tool, presenters)
  const suppressToggle = useRef(false)
  const runInlineAction = (action: () => void) => {
    suppressToggle.current = true
    action()
    queueMicrotask(() => { suppressToggle.current = false })
  }
  const toggleExpanded = () => {
    if (suppressToggle.current) {
      suppressToggle.current = false
      return
    }
    onToggle()
  }
  const args = formatArgs(tool.args, tool.argsText)
  const content = presentation.content.length > MAX_TOOL_OUTPUT
    ? `${presentation.content.slice(0, MAX_TOOL_OUTPUT)}\n\n[Display truncated]`
    : presentation.content
  const icon = toolIcon(tool.name)
  const summary = presentation.title ?? toolSummary(tool)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', fontFamily: nativeTheme.fontMono }}>
      <div
        testId="tool-detail-row"
        tabIndex={0}
        style={{
          minHeight: 28,
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 7,
          paddingLeft: 4,
          paddingRight: 5,
          borderRadius: 6,
          cursor: 'pointer',
          hover: { color: colors.text },
        }}
        onClick={toggleExpanded}
        onKeyDown={(event) => { if (event.key === 'enter') toggleExpanded() }}
      >
        <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={tool.isError ? 'x' : icon} size={15} color={tool.isError ? colors.error : colors.textFaint} />
        </div>
        <text testId="tool-summary-label" style={{ color: colors.textMuted, fontSize: 12, minWidth: 0, flexShrink: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontMono, hover: { color: colors.text } }}>{summary}</text>
        <div style={{ flexGrow: 1 }} />
        <InlineAction icon="copy" testId="copy-tool" onClick={() => runInlineAction(() => { void copyTextToClipboard(toolCopyText(tool, args, content)) })} />
        {item.revertEntryId && <InlineAction icon="undo" testId="revert-tool" onClick={() => runInlineAction(() => onRevert(item.revertEntryId!))} />}
        <text style={{ color: tool.isError ? colors.error : tool.status === 'complete' ? colors.textFaint : colors.info, fontSize: 10, fontFamily: nativeTheme.fontMono }}>
          {tool.isError ? 'failed' : tool.status === 'complete' ? 'done' : tool.status}
        </text>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} color={colors.textFaint} />
      </div>
      {!expanded && presentation.fabric && presentation.fabric.audits.length > 0 && <FabricCollapsedCalls audits={presentation.fabric.audits} />}
      {expanded && (presentation.fabric ? (
        <FabricToolBody fabric={presentation.fabric} output={content} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 7, paddingLeft: 31, paddingTop: 4, paddingBottom: 6 }}>
          {args && <code code={args} language="json" theme={nativeTheme} style={codeSurfaceStyle()} />}
          {content ? (
            presentation.kind === 'diff'
              ? <diff patch={content} wordDiff maxLines={500} theme={nativeTheme} style={{ width: '100%', fontFamily: nativeTheme.fontMono }} />
              : (
                <code
                  code={content}
                  theme={nativeTheme}
                  style={codeSurfaceStyle()}
                  {...(presentation.language ? { language: presentation.language } : {})}
                  {...(presentation.path ? { path: presentation.path } : {})}
                />
              )
          ) : tool.status === 'complete' ? null : (
            <text style={{ color: colors.textFaint, fontSize: 11, fontFamily: nativeTheme.fontMono }}>Waiting for output…</text>
          )}
        </div>
      ))}
    </div>
  )
}

function FabricCollapsedCalls({ audits }: { audits: FabricAuditPresentation[] }) {
  const visible = collapsedFabricAudits(audits)
  const hidden = audits.length - visible.length
  return (
    <div testId="fabric-collapsed-calls" style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 35, paddingRight: 5, paddingTop: 2, paddingBottom: 5 }}>
      {visible.map((audit, index) => (
        <div key={`${audit.ref}-${index}`} testId="fabric-collapsed-call" style={{ minHeight: 19, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <text style={{ width: 10, color: audit.success === false ? colors.error : audit.success === true ? colors.textFaint : colors.warning, fontSize: 11 }}>{audit.success === false ? '×' : audit.success === true ? '›' : '•'}</text>
          <text style={{ width: 0, minWidth: 0, flexGrow: 1, overflow: 'hidden', color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{fabricAuditHeadline(audit)}</text>
          <text testId="fabric-collapsed-status" style={{ width: 42, flexShrink: 0, color: audit.success === false ? colors.error : colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono, textAlign: 'right' }}>{audit.success === false ? 'failed' : audit.success === true ? 'done' : 'running'}</text>
        </div>
      ))}
      {hidden > 0 && <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>{`… ${hidden} nested ${hidden === 1 ? 'call' : 'calls'} hidden`}</text>}
    </div>
  )
}

function FabricToolBody({ fabric, output }: { fabric: FabricToolPresentation; output: string }) {
  const lineCount = fabric.code ? fabric.code.split('\n').length : 0
  const summaryPalette = fabricSummaryPalette()
  return (
    <div testId="fabric-tool-body" style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 9, paddingLeft: 31, paddingTop: 5, paddingBottom: 8 }}>
      <div testId="fabric-summary-card" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 11, borderRadius: 10, borderWidth: 1, borderColor: summaryPalette.border, backgroundColor: summaryPalette.background }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Icon name="sparkles" size={14} color={colors.info} />
          <text testId="fabric-summary-name" style={{ color: summaryPalette.name, fontSize: 12, fontWeight: 650, fontFamily: nativeTheme.fontMono }}>{fabric.name}</text>
          <div style={{ flexGrow: 1 }} />
          <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>{`TypeScript · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}</text>
        </div>
        {fabric.description && <text testId="fabric-summary-description" style={{ color: summaryPalette.description, fontSize: 11, lineHeight: 17, fontFamily: nativeTheme.fontMono }}>{fabric.description}</text>}
      </div>
      {fabric.code && <code code={fabric.code} language="typescript" theme={nativeTheme} style={codeSurfaceStyle()} />}
      {fabric.audits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {fabric.audits.map((audit, index) => <FabricAuditCard key={`${audit.ref}-${index}`} audit={audit} />)}
        </div>
      )}
      {output && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, fontFamily: nativeTheme.fontMono }}>RESULT</text>
          <code code={output} language={fabric.outputLanguage ?? 'text'} theme={nativeTheme} style={codeSurfaceStyle()} />
        </div>
      )}
    </div>
  )
}

export function fabricSummaryPalette() {
  return {
    background: colors.card,
    border: colors.borderStrong,
    name: colors.text,
    description: colors.textMuted,
  }
}

function FabricAuditCard({ audit }: { audit: FabricAuditPresentation }) {
  const result = formatFabricValue(audit.error ?? audit.result)
  const path = typeof audit.args?.path === 'string' ? audit.args.path : undefined
  const language = fabricAuditLanguage(audit)
  const title = [audit.provider, audit.tool].filter(Boolean).join('.') || audit.ref
  return (
    <div testId="fabric-nested-call" style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 9, borderRadius: 9, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.card }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
        <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: audit.success === false ? colors.error : audit.success === true ? colors.success : colors.info }} />
        <text style={{ color: colors.textMuted, fontSize: 11, fontFamily: nativeTheme.fontMono }}>{title}</text>
        <div style={{ flexGrow: 1 }} />
        {audit.durationMs !== undefined && <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>{formatDuration(audit.durationMs)}</text>}
      </div>
      {audit.args && <code code={formatFabricValue(audit.args)} language="json" theme={nativeTheme} style={codeSurfaceStyle()} />}
      {result && (
        <code
          code={result}
          theme={nativeTheme}
          style={codeSurfaceStyle()}
          {...(language ? { language } : {})}
          {...(path ? { path } : {})}
        />
      )}
    </div>
  )
}

function fabricAuditLanguage(audit: FabricAuditPresentation): string | undefined {
  const tool = `${audit.provider ?? ''}.${audit.tool ?? ''}.${audit.ref}`.toLowerCase()
  if (tool.includes('bash')) return 'bash'
  if (tool.includes('grep') || tool.includes('find')) return 'text'
  if (tool.includes('edit')) return 'diff'
  return undefined
}

function collapsedFabricAudits(audits: FabricAuditPresentation[]): FabricAuditPresentation[] {
  if (audits.length <= FABRIC_COLLAPSED_CALL_LIMIT) return audits
  const selected = new Set(audits.flatMap((audit, index) => audit.success === undefined ? [index] : []).slice(-FABRIC_COLLAPSED_CALL_LIMIT))
  for (let index = 0; index < audits.length && selected.size < FABRIC_COLLAPSED_CALL_LIMIT; index += 1) selected.add(index)
  return [...selected].sort((left, right) => left - right).map((index) => audits[index]!)
}

function fabricAuditHeadline(audit: FabricAuditPresentation): string {
  const tool = [audit.provider, audit.tool].filter(Boolean).join('.') || audit.ref
  const path = typeof audit.args?.path === 'string' ? audit.args.path : undefined
  const command = typeof audit.args?.command === 'string' ? audit.args.command : undefined
  const pattern = typeof audit.args?.pattern === 'string' ? audit.args.pattern : undefined
  const detail = path ?? command ?? pattern
  return detail ? `${tool} ${compactOneLine(detail)}` : tool
}

function markdownPreview(value: string): string {
  return compactOneLine(value
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*(?:>|[-+*]|\d+[.)])\s+/gm, '')
    .replace(/[*_~`]/g, ''))
}

function compactOneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function formatFabricValue(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value.slice(0, 18_000)
  try {
    return JSON.stringify(value, null, 2).slice(0, 18_000)
  } catch {
    return String(value).slice(0, 18_000)
  }
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${Math.round(durationMs)}ms` : `${(durationMs / 1_000).toFixed(1)}s`
}

function MessageImage({ image }: { image: PiImageContent }) {
  return (
    <div style={{ width: 156, height: 104, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, overflow: 'hidden' }}>
      {image.previewPath
        ? React.createElement('img', { src: image.previewPath, alt: 'Attached image', objectFit: 'cover', style: { width: 156, height: 104 } } as never)
        : <text style={{ color: colors.textFaint, fontSize: 11 }}>Attached image</text>}
    </div>
  )
}

function MessageFooter({
  timestamp,
  copyText,
  revertEntryId,
  align,
  onRevert,
}: {
  timestamp?: number | undefined
  copyText: string
  revertEntryId?: string | undefined
  align: 'start' | 'end'
  onRevert(entryId: string): void
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!await copyTextToClipboard(copyText)) return
    setCopied(true)
    setTimeout(() => setCopied(false), 900)
  }
  const actions = (
    <>
      {revertEntryId && <InlineAction icon="gitBranch" testId="fork-message" onClick={() => onRevert(revertEntryId)} />}
      {copyText && <InlineAction icon={copied ? 'check' : 'copy'} testId="copy-message" onClick={() => void copy()} />}
    </>
  )
  return (
    <div testId="message-footer" style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: align === 'end' ? 'flex-end' : 'flex-start', gap: 5 }}>
      {align === 'start' && actions}
      {timestamp && <Timestamp value={timestamp} />}
      {align === 'end' && actions}
    </div>
  )
}

function InlineAction({ icon, testId, onClick }: { icon: IconName; testId: string; onClick(): void }) {
  return (
    <div testId={testId} tabIndex={0} style={{ width: 24, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter') onClick() }}>
      <Icon name={icon} size={13} color={colors.textFaint} />
    </div>
  )
}

function toolCopyText(tool: ToolRun, args: string, content: string): string {
  return [tool.name, args, content].filter(Boolean).join('\n\n')
}

function WorkingRow({ activity }: { activity: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingLeft: 20, paddingRight: 20, paddingTop: 2, paddingBottom: 8 }}>
      <div style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 5 }}>
        <Icon name="circle" size={14} color={colors.info} />
        <text style={{ color: colors.textMuted, fontSize: 12 }}>{activity === 'Ready' ? 'Working…' : activity}</text>
      </div>
    </div>
  )
}

function StatusMessage({ text, error, timestamp }: { text: string; error: boolean; timestamp?: number | undefined }) {
  return (
    <div style={{ padding: 8, borderRadius: 7, backgroundColor: error ? colors.diffDel : colors.card }}>
      <text style={{ color: error ? colors.error : colors.textMuted, fontSize: 12, lineHeight: 18 }}>{text}</text>
      {timestamp && <Timestamp value={timestamp} />}
    </div>
  )
}

function EmptyConversation({ workspacePath }: { workspacePath: string }) {
  const project = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingLeft: 20, paddingRight: 20, paddingBottom: 190 }}>
      <div style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
        <text style={{ color: colors.text, fontSize: 26, fontWeight: 500 }}>{`What should we build in ${project}?`}</text>
      </div>
    </div>
  )
}

function ComposerSpacer({ noticeCount, questionnaireCollapsed, queue }: { noticeCount: number; questionnaireCollapsed: boolean; queue: WorkbenchState['queue'] }) {
  return <div testId="composer-spacer" style={{ width: '100%', height: 194 + composerNotificationStackHeight(noticeCount) + questionnaireWaitingDockReserveHeight(questionnaireCollapsed) + queueDockReserveHeight(queue) }} />
}

function Timestamp({ value }: { value: number }) {
  return <text style={{ color: colors.textFaint, fontSize: 9 }}>{formatTimestamp(value)}</text>
}

export function ChangedFilesCard({ paths, onOpenDiff }: { paths: string[]; onOpenDiff(): void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 5, padding: 10, borderRadius: 10, backgroundColor: colors.card, fontFamily: nativeTheme.fontMono }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="chevronDown" size={10} color={colors.textFaint} />
        <text style={{ color: colors.text, fontSize: 10, fontWeight: 600, fontFamily: nativeTheme.fontMono }}>{`${paths.length} changed ${paths.length === 1 ? 'file' : 'files'}`}</text>
        <div style={{ flexGrow: 1 }} />
        <div testId="changed-files-open-diff" tabIndex={0} style={{ height: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 7, paddingRight: 7, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onOpenDiff} onKeyDown={(event) => { if (event.key === 'enter') onOpenDiff() }}>
          <Icon name="fileDiff" size={11} color={colors.textFaint} />
          <text style={{ color: colors.textMuted, fontSize: 9, fontFamily: nativeTheme.fontMono }}>Open diff</text>
        </div>
      </div>
      {paths.map((path) => (
        <React.Fragment key={path}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 13 }}>
            <Icon name="fileDiff" size={11} color={colors.textFaint} />
            <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontMono }}>{path}</text>
          </div>
        </React.Fragment>
      ))}
    </div>
  )
}

function traceDuration(items: Array<Pick<TimelineItem, 'timestamp'>>): string | undefined {
  let earliest = Number.POSITIVE_INFINITY
  let latest = Number.NEGATIVE_INFINITY
  let timestampCount = 0
  for (const item of items) {
    if (typeof item.timestamp !== 'number' || !Number.isFinite(item.timestamp)) continue
    earliest = Math.min(earliest, item.timestamp)
    latest = Math.max(latest, item.timestamp)
    timestampCount += 1
  }
  return timestampCount > 1 ? formatElapsedSeconds((latest - earliest) / 1_000) : undefined
}

function toolIcon(name: string): IconName {
  if (name === 'bash') return 'terminal'
  if (name === 'read') return 'eye'
  if (name === 'edit' || name === 'write') return 'squarePen'
  if (name === 'grep' || name === 'find') return 'search'
  if (name === 'fabric_exec') return 'sparkles'
  return 'wrench'
}

function toolSummary(tool: ToolRun): string {
  const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {}
  const target = typeof args.path === 'string'
    ? args.path
    : typeof args.command === 'string'
      ? args.command
      : typeof args.pattern === 'string'
        ? args.pattern
        : ''
  const verb = tool.name === 'bash'
    ? 'Command run'
    : tool.name === 'read'
      ? 'Read file'
      : tool.name === 'edit'
        ? 'Edited file'
        : tool.name === 'write'
          ? 'Wrote file'
          : tool.name
  return target ? `${verb}  ${target}` : verb
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function formatArgs(args: unknown, raw: string | undefined): string {
  if (args !== undefined) {
    try {
      return JSON.stringify(args, null, 2)
    } catch {
      return String(args)
    }
  }
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}
