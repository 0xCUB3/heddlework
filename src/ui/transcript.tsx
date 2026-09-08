import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import type { PiImageContent, PiMessage } from '../pi/types.ts'
import { isTranscriptDetailRef, TRANSCRIPT_DETAIL_AUTO_MAX_BYTES, TRANSCRIPT_DETAIL_PREFETCH_CONCURRENCY, type TranscriptDetailRef } from '../protocol/transcript.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { workspaceDisplayName } from '../workbench/workspace-name.ts'
import { buildTimeline, type TimelineItem } from '../workbench/timeline.ts'
import { Icon } from './icons.tsx'
import { colors, nativeTheme, useNativeTheme, type ResolvedTheme } from './theme.ts'
import { MathMarkdown } from './math-markdown.tsx'
import { AnsiText } from './ansi-text.tsx'
import { openExternal } from './open-external.ts'

import { copyTextToClipboard, messageHydrationIdentity, messageImageSrc, prepareVisibleMessageImages } from './clipboard-media.ts'
import { NativeVirtualList, type NativeElementHandle, type NativeScrollEvent, type NativeVisibleRangeEvent } from './primitives.tsx'
import { TRANSCRIPT_VIEWPORT_FALLBACK_PX, TRANSCRIPT_VIRTUAL_WINDOW_SIZE, useNativeVirtualWindow, usePrependCount } from './virtual-list.tsx'
import { adaptiveOverscanRows, adaptiveWindowSize, GIANT_MARKDOWN_CHAR_THRESHOLD, reuseRowsById, scheduleAnimationFrame, splitMarkdownBlocks, virtualWindowForTail } from './virtual-window.ts'
import { extensionSurfaceRailReserveHeight, questionnaireWaitingDockReserveHeight } from './composer-surfaces.tsx'
import { queueDockReserveHeight } from './queue-dock.tsx'
import { MotionDiv, READING_LAYOUT_TRANSITION, SPRING_SETTLE_MS, TextShimmer } from './motion.ts'
import { useResponsiveLayout } from './responsive.tsx'
import type { ToolPresenter } from './tool-presenters.ts'
import { resolveToolPresentation } from './tool-presenters.ts'
import { TranscriptInlineAction } from './transcript-actions.tsx'
import { FabricCollapsedCalls, ToolRow, toolIcon, toolSummary } from './transcript-tools.tsx'

export { fabricSummaryPalette } from './transcript-tools.tsx'
import { useThrottledMarkdownSource } from './streaming-markdown.ts'
import {
  currentWorkWave,
  emptyWorkTrace,
  groupWorkItems,
  liveWorkTraceId,
  pendingWorkTraceId,
  projectTranscriptRows,
  transcriptProjectionRowsEqual,
  timelineItemsEqual,
  workTraceLabel,
  type DisplayTimelineItem,
  type TraceTimelineItem,
  type TranscriptProjectionRow,
} from './transcript-projection.ts'

const HISTORY_PREFETCH_ROWS = 8
const MAX_HISTORY_NO_PROGRESS_PAGES = 8
const TRACE_INITIAL_PROJECTED_ROWS = 48
const TRACE_PROJECTION_CHUNK_ROWS = 48
const TRACE_PROJECTION_FRAME_MS = 16
const TRANSCRIPT_ESTIMATED_ROW_HEIGHT = 88
const COLLAPSED_TRACE_TOOL_LIMIT = 8
const COLLAPSED_TRACE_ROW_HEIGHT = 22
const RETIRING_ASSISTANT_HEIGHT = 96
type AssistantTimelineItem = Extract<TimelineItem, { kind: 'assistant' }>
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

type TranscriptRenderRow = TranscriptProjectionRow
  | { id: 'empty-conversation'; kind: 'empty-conversation' }
  | { id: 'working'; kind: 'working' }
  | { id: 'composer-spacer'; kind: 'composer-spacer' }
  | { id: string; kind: 'retiring-assistant'; item: AssistantTimelineItem }
  | { id: string; kind: 'assistant-block'; item: AssistantTimelineItem; blockIndex: number; blockCount: number; source: string }

let historicalTextRowBodyExecutions: Map<string, number> | undefined

export function resetHistoricalTextRowBodyExecutions(): void {
  historicalTextRowBodyExecutions = new Map()
}

export function historicalTextRowBodyExecutionsSnapshot(): ReadonlyMap<string, number> {
  return new Map(historicalTextRowBodyExecutions)
}

function noteHistoricalTextRowBody(id: string): void {
  historicalTextRowBodyExecutions?.set(id, (historicalTextRowBodyExecutions.get(id) ?? 0) + 1)
}

function stableTraceLengths(previous: Map<string, number> | undefined, items: readonly DisplayTimelineItem[]): Map<string, number> {
  let count = 0
  let changed = !previous
  for (const item of items) {
    if (item.kind !== 'work-trace') continue
    count += 1
    if (!previous || previous.get(item.id) !== item.items.length) changed = true
  }
  if (!changed && previous && previous.size === count) return previous
  const next = new Map<string, number>()
  for (const item of items) {
    if (item.kind === 'work-trace') next.set(item.id, item.items.length)
  }
  return next
}

const GIANT_SPLIT_CACHE_LIMIT = 48
const giantSplitCache = new Map<string, { text: string; blocks: string[] }>()

function expandGiantAssistantRows(rows: TranscriptRenderRow[]): TranscriptRenderRow[] {
  const expanded: TranscriptRenderRow[] = []
  const tailStart = Math.max(0, rows.length - TRANSCRIPT_VIRTUAL_WINDOW_SIZE)
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!
    if (row.kind !== 'timeline-item' || row.item.kind !== 'assistant' || row.item.text.length < GIANT_MARKDOWN_CHAR_THRESHOLD) {
      expanded.push(row)
      continue
    }
    const nearTail = rowIndex >= tailStart || row.item.streaming
    if (!nearTail) {
      expanded.push(row)
      continue
    }
    const cacheKey = row.item.id
    const cached = giantSplitCache.get(cacheKey)
    const blocks = cached?.text === row.item.text ? cached.blocks : splitMarkdownBlocks(row.item.text)
    if (blocks.length <= 1) {
      expanded.push(row)
      continue
    }
    const baseId = row.item.streaming
      ? row.item.id.replace(/-(?:text|thinking)-\d+$/, '')
      : (entryIdFromRowId(row.id) ?? row.id)
    const split: TranscriptRenderRow[] = []
    for (let index = 0; index < blocks.length; index += 1) {
      split.push({
        id: baseId + ':block:' + String(index),
        kind: 'assistant-block',
        item: row.item,
        blockIndex: index,
        blockCount: blocks.length,
        source: blocks[index]!,
      })
    }
    giantSplitCache.delete(cacheKey)
    giantSplitCache.set(cacheKey, { text: row.item.text, blocks })
    while (giantSplitCache.size > GIANT_SPLIT_CACHE_LIMIT) {
      const oldest = giantSplitCache.keys().next().value
      if (!oldest) break
      giantSplitCache.delete(oldest)
    }
    expanded.push(...split)
  }
  return expanded
}

function visibleHydrationIds(messages: readonly PiMessage[], visibleRowIds: readonly string[]): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    const identity = messageHydrationIdentity(message)
    if (!identity) continue
    if (visibleRowIds.some((rowId) => rowBelongsToEntry(rowId, identity))) ids.add(identity)
  }
  return ids
}

function rowBelongsToEntry(rowId: string, entryId: string): boolean {
  const prefix = `entry-${entryId}`
  return rowId === prefix || rowId.startsWith(`${prefix}-`) || rowId.startsWith(`${prefix}:`)
}

function detailRefFromUnknown(value: unknown): TranscriptDetailRef | undefined {
  return isTranscriptDetailRef(value) ? value : undefined
}

function collectDetailStubs(
  messages: readonly PiMessage[],
  liveTools: readonly { id: string; detailRef?: unknown }[] = [],
  liveAssistant?: { id: string; blocks: readonly { index: number; detailRef?: unknown }[] },
): Map<string, TranscriptDetailRef> {
  const stubs = new Map<string, TranscriptDetailRef>()
  for (const message of messages) {
    const ref = detailRefFromUnknown(message.detailRef)
    if (!ref) continue
    stubs.set(ref.entryId, ref)
    if (typeof message.workbenchEntryId === 'string' && message.workbenchEntryId) stubs.set(message.workbenchEntryId, ref)
    if (typeof message.toolCallId === 'string' && message.toolCallId) stubs.set(message.toolCallId, ref)
  }
  for (const tool of liveTools) {
    const ref = detailRefFromUnknown(tool.detailRef)
    if (!ref) continue
    stubs.set(ref.entryId, ref)
    stubs.set(tool.id, ref)
  }
  if (liveAssistant) {
    for (const block of liveAssistant.blocks) {
      const ref = detailRefFromUnknown(block.detailRef)
      if (!ref) continue
      stubs.set(ref.entryId, ref)
      stubs.set(liveAssistant.id, ref)
    }
  }
  return stubs
}

function entryIdFromRowId(rowId: string): string | undefined {
  const block = rowId.indexOf(':block:')
  const id = block >= 0 ? rowId.slice(0, block) : rowId
  if (id.startsWith('entry-') && id.endsWith('-user')) return id.slice(6, -5)
  if (id.startsWith('entry-') && id.endsWith('-assistant')) return id.slice(6, -10)
  const text = /^entry-(.+)-text-\d+$/.exec(id)
  if (text) return text[1]
  if (id.startsWith('tool-')) return id.slice(5)
  return undefined
}

function stubForRow(row: TranscriptRenderRow, stubs: ReadonlyMap<string, TranscriptDetailRef>): TranscriptDetailRef | undefined {
  if (row.kind === 'timeline-item' || row.kind === 'assistant-block') {
    const entryId = entryIdFromRowId(row.id)
    if (entryId && stubs.has(entryId)) return stubs.get(entryId)
  }
  if (row.kind === 'trace-entry' && row.item.kind === 'tool') return stubs.get(row.item.tool.id)
  if (row.kind === 'trace-header') {
    for (const item of row.trace.items) {
      if (item.kind === 'tool') {
        const stub = stubs.get(item.tool.id)
        if (stub) return stub
      }
    }
  }
  return undefined
}

function shouldAutoHydrateRow(row: TranscriptRenderRow, expandedTraceIds: ReadonlySet<string>): boolean {
  if (row.kind === 'assistant-block') return true
  if (row.kind === 'timeline-item') return row.item.kind === 'assistant' || row.item.kind === 'user'
  if (row.kind === 'trace-entry' && row.item.kind === 'tool') return true
  if (row.kind === 'trace-header' && expandedTraceIds.has(row.id)) return true
  return false
}

function shouldShowDetailControl(
  row: TranscriptRenderRow,
  stub: TranscriptDetailRef,
  status: 'loading' | 'error' | undefined,
): boolean {
  if (row.kind === 'trace-header') return false
  if (status === 'error' || status === 'loading') return true
  if (stub.bytes > TRANSCRIPT_DETAIL_AUTO_MAX_BYTES) return true
  return false
}

interface TranscriptDisclosureState {
  sessionKey: string
  traces: Set<string>
  entries: Set<string>
  traceLimits: Map<string, number>
}

const EMPTY_IDS: ReadonlySet<string> = new Set()
const EMPTY_LIMITS: ReadonlyMap<string, number> = new Map()

function transcriptRenderRowsEqual(left: TranscriptRenderRow, right: TranscriptRenderRow): boolean {
  if (left === right) return true
  if (left.id !== right.id || left.kind !== right.kind) return false
  if (left.kind === 'retiring-assistant' && right.kind === 'retiring-assistant') return timelineItemsEqual(left.item, right.item)
  if (left.kind === 'assistant-block' && right.kind === 'assistant-block') {
    return left.blockIndex === right.blockIndex && left.blockCount === right.blockCount && left.source === right.source && timelineItemsEqual(left.item, right.item)
  }
  if (left.kind === 'empty-conversation' || left.kind === 'working' || left.kind === 'composer-spacer') return true
  return transcriptProjectionRowsEqual(left as TranscriptProjectionRow, right as TranscriptProjectionRow)
}

function useStableTranscriptRows(rows: TranscriptRenderRow[], identity: string): TranscriptRenderRow[] {
  const previous = useRef({ identity, rows: [] as TranscriptRenderRow[] })
  if (previous.current.identity !== identity) {
    previous.current = { identity, rows }
    return rows
  }
  const next = reuseRowsById(previous.current.rows, rows, transcriptRenderRowsEqual)
  previous.current = { identity, rows: next }
  return next
}

export const Transcript = memo(function Transcript({
  state,
  presenters,
  onOpenDiff,
  onRevert,
  onDismissNotice = () => undefined,
  onLoadEarlier,
  onLoadDetail,
  appearance,
  interactionDisabled = false,
}: {
  state: WorkbenchState
  presenters: ReadonlyMap<string, ToolPresenter>
  onOpenDiff(): void
  onRevert(entryId: string): void
  onDismissNotice?(id: number): void
  onLoadEarlier?(): void | Promise<void>
  onLoadDetail?(entryId: string): Promise<void>
  appearance?: ResolvedTheme
  interactionDisabled?: boolean
}) {
  useNativeTheme()
  const renderer = useGpuixRequired()
  const sessionKey = state.session.sessionFile ?? state.session.sessionId ?? state.workspacePath
  const onOpenDiffRef = useRef(onOpenDiff)
  const onRevertRef = useRef(onRevert)
  const onDismissNoticeRef = useRef(onDismissNotice)
  const onLoadDetailRef = useRef(onLoadDetail)
  onOpenDiffRef.current = onOpenDiff
  onRevertRef.current = onRevert
  onDismissNoticeRef.current = onDismissNotice
  onLoadDetailRef.current = onLoadDetail
  const stableOpenDiff = useCallback(() => { onOpenDiffRef.current() }, [])
  const stableRevert = useCallback((entryId: string) => { onRevertRef.current(entryId) }, [])
  const stableDismissNotice = useCallback((id: number) => { onDismissNoticeRef.current?.(id) }, [])
  const listRef = useRef<NativeElementHandle | null>(null)
  const [viewportHeight, setViewportHeight] = useState(() => {
    const size = typeof renderer.getWindowSize === 'function' ? renderer.getWindowSize() : undefined
    return size && size.height > 0 ? size.height : TRANSCRIPT_VIEWPORT_FALLBACK_PX
  })
  const [detailStatus, setDetailStatus] = useState<Map<string, 'loading' | 'error'>>(() => new Map())
  const detailGeneration = useRef(0)
  const detailInFlight = useRef(new Map<string, Promise<void>>())
  const detailPrefetched = useRef(new Set<string>())
  const detailPrefetchCancel = useRef<(() => void) | undefined>(undefined)
  const paging = useRef<object | undefined>(undefined)
  const previewLeases = useRef(new Map<string, number>())
  const previewLeaseSession = useRef(sessionKey)
  const visibleStartIndex = useRef<number | undefined>(undefined)
  const historyDemandDirection = useRef<'older' | 'newer' | 'idle'>('idle')
  const pendingHistoryPage = useRef<{ anchorId: string | undefined; continuation: number } | undefined>(undefined)
  if (previewLeaseSession.current !== sessionKey) {
    previewLeaseSession.current = sessionKey
    previewLeases.current = new Map()
  }
  const [disclosures, setDisclosures] = useState<TranscriptDisclosureState>(() => ({ sessionKey, traces: new Set(), entries: new Set(), traceLimits: new Map() }))
  const [retiringAssistants, setRetiringAssistants] = useState<AssistantTimelineItem[]>([])
  const [followTail, setFollowTail] = useState(() => state.session.isStreaming)
  const followTailRef = useRef(followTail)
  followTailRef.current = followTail
  const previousAssistants = useRef<AssistantTimelineItem[]>([])
  const wasStreaming = useRef(state.session.isStreaming)
  const previousMessageCount = useRef(state.messages.length)
  const stickyHeaderIds = useRef(new Set<string>())
  const expandedTraceIds = disclosures.sessionKey === sessionKey ? disclosures.traces : EMPTY_IDS
  const expandedEntryIds = disclosures.sessionKey === sessionKey ? disclosures.entries : EMPTY_IDS
  const traceLimits = disclosures.sessionKey === sessionKey ? disclosures.traceLimits : EMPTY_LIMITS

  useEffect(() => {
    paging.current = undefined
    pendingHistoryPage.current = undefined
    visibleStartIndex.current = undefined
    historyDemandDirection.current = 'idle'
    previousAssistants.current = []
    wasStreaming.current = state.session.isStreaming
    previousMessageCount.current = state.messages.length
    stickyHeaderIds.current = new Set()
    setRetiringAssistants([])
    setFollowTail(state.session.isStreaming)
    detailGeneration.current += 1
    detailInFlight.current = new Map()
    detailPrefetched.current = new Set()
    detailPrefetchCancel.current?.()
    detailPrefetchCancel.current = undefined
    setDetailStatus(new Map())
    return () => {
      paging.current = undefined
      detailGeneration.current += 1
      detailPrefetchCancel.current?.()
    }
  }, [sessionKey])

  const [preparedImages, setPreparedImages] = useState<{ source: readonly PiMessage[]; messages: PiMessage[] }>(() => ({
    source: state.messages,
    messages: state.messages,
  }))
  const hydratedMessages = preparedImages.source === state.messages ? preparedImages.messages : state.messages
  const items = useMemo(
    () => groupWorkItems(buildTimeline(hydratedMessages, state.liveAssistant, state.liveTools, state.forkMessages, 0, state.notices), state.session.isStreaming),
    [hydratedMessages, state.forkMessages, state.liveAssistant, state.liveTools, state.notices, state.session.isStreaming],
  )
  const traceLengthsRef = useRef<Map<string, number>>(new Map())
  const traceLengths = useMemo(() => {
    const next = stableTraceLengths(traceLengthsRef.current, items)
    traceLengthsRef.current = next
    return next
  }, [items])
  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey
  const projectedRows = useMemo(() => projectTranscriptRows(items, expandedTraceIds, traceLimits), [expandedTraceIds, items, traceLimits])
  const displayedAssistants = useMemo(
    () => items.flatMap((item) => item.kind === 'assistant' ? [item] : []),
    [items],
  )
  useEffect(() => {
    const displayedIds = new Set(displayedAssistants.map((item) => item.id))
    const displayedTexts = new Set(displayedAssistants.map((item) => item.text))
    const disappeared = previousAssistants.current.filter((item) => !displayedIds.has(item.id) && !displayedTexts.has(item.text))
    previousAssistants.current = displayedAssistants
    setRetiringAssistants((current) => {
      const remaining = current.filter((item) => !displayedIds.has(item.id) && !displayedTexts.has(item.text))
      if (disappeared.length === 0) return remaining.length === current.length ? current : remaining
      const known = new Set(remaining.map((item) => item.id))
      return [...remaining, ...disappeared.filter((item) => !known.has(item.id))]
    })
  }, [displayedAssistants])
  useEffect(() => {
    // Starting a turn must not override an explicit historical reading position.
    if (state.session.isStreaming && !wasStreaming.current && historyDemandDirection.current === 'idle') setFollowTail(true)
    wasStreaming.current = state.session.isStreaming
  }, [state.session.isStreaming])
  useEffect(() => {
    if (previousMessageCount.current === 0 && state.messages.length > 0) setFollowTail(true)
    previousMessageCount.current = state.messages.length
  }, [state.messages.length])
  const retiringIds = retiringAssistants.map((item) => item.id).join('|')
  useEffect(() => {
    if (!retiringIds) return
    const timer = setTimeout(() => setRetiringAssistants([]), SPRING_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [retiringIds])
  const liveTraceId = useMemo(
    () => liveWorkTraceId(items, state.session.isStreaming) ?? pendingWorkTraceId(items, state.session.isStreaming),
    [items, state.session.isStreaming],
  )
  if (liveTraceId) stickyHeaderIds.current.add(liveTraceId)
  const rows = useMemo<TranscriptRenderRow[]>(() => {
    const visibleRows = projectedRows.filter((row) => {
      if (row.kind !== 'trace-entry' && row.kind !== 'trace-notices' && row.kind !== 'trace-continuation') return true
      return (traceLengths.get(row.traceId) ?? 0) > TRACE_INITIAL_PROJECTED_ROWS
    })
    const next: TranscriptRenderRow[] = visibleRows.length > 0 ? [...visibleRows] : [{ id: 'empty-conversation', kind: 'empty-conversation' }]
    const insertAt = next.findIndex((row) => row.kind === 'working' || row.kind === 'composer-spacer')
    const retiringRows: TranscriptRenderRow[] = retiringAssistants.map((item) => ({ id: `retiring:${item.id}`, kind: 'retiring-assistant', item }))
    if (retiringRows.length > 0) next.splice(insertAt === -1 ? next.length : insertAt, 0, ...retiringRows)
    if (liveTraceId && !next.some((row) => row.id === liveTraceId)) next.push({ id: liveTraceId, kind: 'trace-header', trace: emptyWorkTrace(liveTraceId) })
    else if (state.session.isStreaming && !liveTraceId && !items.some((item) => item.kind === 'assistant' || item.kind === 'work-trace')) next.push({ id: 'working', kind: 'working' })
    next.push({ id: 'composer-spacer', kind: 'composer-spacer' })
    return expandGiantAssistantRows(next)
  }, [items, liveTraceId, projectedRows, retiringAssistants, state.session.isStreaming, traceLengths])
  const stableRows = useStableTranscriptRows(rows, sessionKey)
  const rowIds = useMemo(() => stableRows.map((row) => row.id), [stableRows])
  const prepended = usePrependCount(rowIds, sessionKey)
  const overscanRows = adaptiveOverscanRows(viewportHeight, TRANSCRIPT_ESTIMATED_ROW_HEIGHT)
  const transcriptWindowSize = adaptiveWindowSize(viewportHeight, TRANSCRIPT_ESTIMATED_ROW_HEIGHT, overscanRows, TRANSCRIPT_VIRTUAL_WINDOW_SIZE)
  const virtualWindow = useNativeVirtualWindow(
    stableRows.length,
    sessionKey,
    virtualWindowForTail(stableRows.length, transcriptWindowSize),
    transcriptWindowSize,
    {
      pinToEnd: followTail,
      prepended,
      viewportHeight,
      estimatedItemHeight: TRANSCRIPT_ESTIMATED_ROW_HEIGHT,
      overscan: overscanRows,
    },
  )
  const visibleRows = stableRows.slice(virtualWindow.windowStart, virtualWindow.windowEnd)
  const visibleRowIdsRef = useRef<string[]>([])
  if (visibleRowIdsRef.current.length !== visibleRows.length || visibleRows.some((row, index) => row.id !== visibleRowIdsRef.current[index])) {
    visibleRowIdsRef.current = visibleRows.map((row) => row.id)
  }
  const visibleRowIds = visibleRowIdsRef.current
  const detailStubs = useMemo(() => collectDetailStubs(state.messages, state.liveTools, state.liveAssistant), [state.liveAssistant, state.liveTools, state.messages])
  useEffect(() => {
    const source = state.messages
    const ids = visibleHydrationIds(source, visibleRowIds)
    const controller = new AbortController()
    void prepareVisibleMessageImages(source, ids, { signal: controller.signal }).then((messages) => {
      if (controller.signal.aborted) return
      setPreparedImages((current) => {
        if (current.source === source && current.messages.length === messages.length && current.messages.every((message, index) => message === messages[index])) return current
        return { source, messages }
      })
    }).catch(() => { /* Keep the original image source when preview preparation fails. */ })
    return () => { controller.abort() }
  }, [state.messages, visibleRowIds])
  const rowIndexById = useMemo(() => new Map(stableRows.map((row, index) => [row.id, index])), [stableRows])
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
    if (sessionKeyRef.current !== sessionKey || historyDemandDirection.current !== 'older' || !onLoadEarlier || !state.messagesHasOlder || state.messagesLoadingEarlier || paging.current) return
    const token = {}
    paging.current = token
    pendingHistoryPage.current = { anchorId: stableRows[0]?.id, continuation }
    const finish = (failed = false) => {
      if (paging.current !== token) return
      paging.current = undefined
      if (failed) pendingHistoryPage.current = undefined
    }
    try {
      const request = onLoadEarlier()
      if (request) void request.then(() => finish(), () => finish(true))
      else finish()
    } catch {
      finish(true)
    }
  }
  const handleVisibleRange = (event: NativeVisibleRangeEvent) => {
    if (sessionKeyRef.current !== sessionKey) return
    const scrollTop = listRef.current ? renderer.getListScrollTop?.(listRef.current.id) : undefined
    const listViewport = scrollTop?.[2]
    const atEnd = event.atEnd ?? ((scrollTop?.[0] ?? -1) >= stableRows.length)
    if (atEnd && historyDemandDirection.current === 'newer' && !followTailRef.current) {
      followTailRef.current = true
      setFollowTail(true)
    }
    const nextViewport = (typeof event.viewportHeight === 'number' && event.viewportHeight > 0)
      ? event.viewportHeight
      : (typeof listViewport === 'number' && listViewport > 0 ? listViewport : undefined)
    if (nextViewport && Math.abs(nextViewport - viewportHeight) >= 1) setViewportHeight(nextViewport)
    virtualWindow.onVisibleRange(event)
    if (typeof event.startIndex !== 'number') return
    const firstVisible = Math.max(0, Math.floor(event.startIndex))
    const previousFirst = visibleStartIndex.current
    visibleStartIndex.current = firstVisible
    // Opening a session lands pinned to the tail and must not page on its own. Travel toward older rows counts as
    // upward intent even without a wheel delta: a shrinking first index, or a viewport parked at the top of a list
    // whose tail is out of view (keyboard or programmatic scroll-to-top).
    if (historyDemandDirection.current === 'idle') {
      const lastVisible = typeof event.endIndex === 'number' ? Math.floor(event.endIndex) : stableRows.length - 1
      const tailOutOfView = lastVisible < stableRows.length - 1 - HISTORY_PREFETCH_ROWS
      if ((previousFirst !== undefined && firstVisible < previousFirst) || (firstVisible === 0 && tailOutOfView && !followTailRef.current)) {
        historyDemandDirection.current = 'older'
      }
    }
    if (firstVisible <= HISTORY_PREFETCH_ROWS) loadEarlier()
  }
  // Downward intent owns the viewport and cancels every queued hidden-page continuation.
  const handleHistoryScroll = (event: NativeScrollEvent) => {
    if (sessionKeyRef.current !== sessionKey) return
    if (typeof event.deltaY !== 'number' || event.deltaY === 0) return
    if (followTailRef.current && event.deltaY > 0) {
      followTailRef.current = false
      setFollowTail(false)
    }
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

  const toggleTrace = useCallback((traceId: string) => {
    const currentSessionKey = sessionKeyRef.current
    const lengths = traceLengthsRef.current
    setDisclosures((current) => {
      const traces = new Set(current.sessionKey === currentSessionKey ? current.traces : EMPTY_IDS)
      if (traces.has(traceId)) traces.delete(traceId)
      else traces.add(traceId)
      const nextLimits = new Map(current.sessionKey === currentSessionKey ? current.traceLimits : EMPTY_LIMITS)
      if (traces.has(traceId)) nextLimits.set(traceId, Math.min(TRACE_INITIAL_PROJECTED_ROWS, lengths.get(traceId) || TRACE_INITIAL_PROJECTED_ROWS))
      else nextLimits.delete(traceId)
      return { sessionKey: currentSessionKey, traces, entries: new Set(current.sessionKey === currentSessionKey ? current.entries : EMPTY_IDS), traceLimits: nextLimits }
    })
  }, [])
  const toggleEntry = useCallback((rowId: string) => {
    const currentSessionKey = sessionKeyRef.current
    setDisclosures((current) => {
      const entries = new Set(current.sessionKey === currentSessionKey ? current.entries : EMPTY_IDS)
      if (entries.has(rowId)) entries.delete(rowId)
      else entries.add(rowId)
      return { sessionKey: currentSessionKey, traces: new Set(current.sessionKey === currentSessionKey ? current.traces : EMPTY_IDS), entries, traceLimits: new Map(current.sessionKey === currentSessionKey ? current.traceLimits : EMPTY_LIMITS) }
    })
  }, [])
  const leasePreviewHeight = useCallback((key: string, natural: number, hold: boolean) => {
    if (!hold) {
      previewLeases.current.delete(key)
      return natural
    }
    const next = Math.max(previewLeases.current.get(key) ?? 0, natural)
    previewLeases.current.set(key, next)
    return next
  }, [])
  const finishRetire = useCallback((id: string) => {
    setRetiringAssistants((current) => current.filter((item) => item.id !== id))
  }, [])
  const loadDetail = useCallback(async (entryId: string, options: { silent?: boolean } = {}) => {
    const loader = onLoadDetailRef.current
    if (!loader || !entryId || entryId.startsWith('anon:')) return
    const existing = detailInFlight.current.get(entryId)
    if (existing) {
      await existing
      return
    }
    const generation = detailGeneration.current
    if (!options.silent) {
      setDetailStatus((current) => {
        const next = new Map(current)
        next.set(entryId, 'loading')
        return next
      })
    }
    let request!: Promise<void>
    request = (async () => {
      try {
        // Register the promise before calling a loader that may throw synchronously.
        await Promise.resolve().then(() => generation === detailGeneration.current ? loader(entryId) : undefined)
        if (generation !== detailGeneration.current) return
        setDetailStatus((current) => {
          const next = new Map(current)
          next.delete(entryId)
          return next
        })
      } catch (error) {
        if (generation !== detailGeneration.current) return
        const message = error instanceof Error ? error.message : String(error)
        if (options.silent && /session changed/i.test(message)) return
        setDetailStatus((current) => {
          const next = new Map(current)
          next.set(entryId, 'error')
          return next
        })
      } finally {
        if (detailInFlight.current.get(entryId) === request) detailInFlight.current.delete(entryId)
      }
    })()
    detailInFlight.current.set(entryId, request)
    await request
  }, [])

  const visibleRowsRef = useRef(visibleRows)
  visibleRowsRef.current = visibleRows
  const detailStatusRef = useRef(detailStatus)
  detailStatusRef.current = detailStatus
  useEffect(() => {
    if (!onLoadDetail) return
    detailPrefetchCancel.current?.()
    detailPrefetchCancel.current = scheduleAnimationFrame(() => {
      detailPrefetchCancel.current = undefined
      let running = detailInFlight.current.size
      for (const row of visibleRowsRef.current) {
        if (running >= TRANSCRIPT_DETAIL_PREFETCH_CONCURRENCY) break
        if (!shouldAutoHydrateRow(row, expandedTraceIds)) continue
        const stub = stubForRow(row, detailStubs)
        if (!stub || stub.entryId.startsWith('anon:')) continue
        if (stub.bytes > TRANSCRIPT_DETAIL_AUTO_MAX_BYTES) continue
        if (detailStatusRef.current.get(stub.entryId) === 'error') continue
        if (detailPrefetched.current.has(stub.entryId) || detailInFlight.current.has(stub.entryId)) continue
        detailPrefetched.current.add(stub.entryId)
        running += 1
        void loadDetail(stub.entryId, { silent: true })
      }
    })
    return () => {
      detailPrefetchCancel.current?.()
      detailPrefetchCancel.current = undefined
    }
  }, [detailStubs, detailStatus, expandedTraceIds, loadDetail, onLoadDetail, visibleRowIds])

  return (
    <div testId="transcript-scroll-surface" style={{ position: 'relative', flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', pointerEvents: interactionDisabled ? 'none' : 'auto' }} onScroll={handleHistoryScroll}>
      <NativeVirtualList
        key={sessionKey}
        testId="transcript-list"
        elementRef={listRef}
        alignment="bottom"
        followTail={followTail}
        onScroll={handleHistoryScroll}
        onVisibleRange={handleVisibleRange}
        overdraw={Math.max(120, Math.round(viewportHeight * 0.35))}
        estimatedItemHeight={TRANSCRIPT_ESTIMATED_ROW_HEIGHT}
        itemCount={stableRows.length}
        windowStart={virtualWindow.windowStart}
        style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
      >
        {visibleRows.map((row) => {
          const stub = stubForRow(row, detailStubs)
          const status = stub ? detailStatus.get(stub.entryId) : undefined
          const control = stub ? { stub, status, onLoad: loadDetail } : undefined
          const detail = control && (row.kind === 'trace-header' || shouldShowDetailControl(row, stub!, status)) ? control : undefined
          return (
          <TranscriptRowTransition key={row.id} row={row} live={row.kind === 'trace-header' && row.id === liveTraceId} persist={row.kind === 'trace-header' && stickyHeaderIds.current.has(row.id)}>
            {row.kind === 'timeline-item' || row.kind === 'assistant-block'
              ? <HistoricalTextRow row={row} onRevert={stableRevert} detail={detail} />
              : row.kind === 'empty-conversation'
                ? <EmptyConversation workspacePath={state.workspacePath} />
                : row.kind === 'working'
                  ? <WorkingRow activity={state.activity} />
                  : row.kind === 'composer-spacer'
                    ? <ComposerSpacer questionnaireCollapsed={state.questionnaireCollapsed !== undefined} queue={state.queue} statusItems={state.statusItems} widgets={state.widgets} />
                    : row.kind === 'retiring-assistant'
                      ? <RetiringAssistantRow item={row.item} onRevert={stableRevert} onDone={() => finishRetire(row.item.id)} />
                      : row.kind === 'trace-header'
                        ? <TraceHeaderRow
                            row={row}
                            presenters={presenters}
                            historyHasOlder={state.messagesHasOlder}
                            live={row.id === liveTraceId}
                            leasePreviewHeight={leasePreviewHeight}
                            expanded={expandedTraceIds.has(row.id)}
                            expandedEntryIds={expandedEntryIds}
                            onToggleTrace={toggleTrace}
                            onToggleEntry={toggleEntry}
                            onRevert={stableRevert}
                            onDismissNotice={stableDismissNotice}
                            detail={detail}
                          />
                        : row.kind === 'trace-notices'
                          ? <TraceNoticesRow notices={row.notices} onDismissNotice={stableDismissNotice} />
                          : row.kind === 'trace-files'
                            ? <TraceFilesRow paths={row.paths} onOpenDiff={stableOpenDiff} />
                            : row.kind === 'trace-continuation'
                              ? <TraceContinuationRow remaining={row.remaining} />
                              : <TraceEntryRow
                                  row={row}
                                  presenters={presenters}
                                  expanded={row.item.kind === 'compaction' ? true : expandedEntryIds.has(row.id)}
                                  onToggleTrace={toggleTrace}
                                  onToggleEntry={toggleEntry}
                                  onRevert={stableRevert}
                                  detail={detail}
                                />}
          </TranscriptRowTransition>
          )
        })}
      </NativeVirtualList>
    </div>
  )
}, (previous, next) => previous.appearance === next.appearance
  && previous.onOpenDiff === next.onOpenDiff
  && previous.onRevert === next.onRevert
  && previous.onDismissNotice === next.onDismissNotice
  && previous.onLoadEarlier === next.onLoadEarlier
  && previous.onLoadDetail === next.onLoadDetail
  && previous.interactionDisabled === next.interactionDisabled
  && previous.presenters === next.presenters
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
  && previous.state.notices === next.state.notices
  && previous.state.questionnaireCollapsed === next.state.questionnaireCollapsed
  && previous.state.queue === next.state.queue
  && previous.state.statusItems === next.state.statusItems
  && previous.state.widgets === next.state.widgets)

function TranscriptRowTransition({ row, live, persist, children }: { row: TranscriptRenderRow; live: boolean; persist: boolean; children: React.ReactNode }) {
  const entered = useRef(false)
  const animated = row.kind === 'working'
    || (row.kind === 'trace-header' && (live || persist))
    || (row.kind === 'timeline-item' && (row.item.kind === 'status' || (row.item.kind === 'assistant' && row.item.streaming)))
  if (!animated) return <>{children}</>
  const initial = entered.current || row.kind === 'trace-header' ? false : { opacity: 0, top: 6 }
  entered.current = true
  return (
    <MotionDiv
      testId="transcript-row-transition"
      initial={initial}
      animate={{ opacity: 1, top: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      style={{ position: 'relative', width: '100%' }}
    >
      {children}
    </MotionDiv>
  )
}

type TranscriptDetailControl = {
  stub: TranscriptDetailRef
  status?: 'loading' | 'error' | undefined
  onLoad(entryId: string): void
}

const HistoricalTextRow = memo(function HistoricalTextRow({
  row,
  onRevert,
  detail,
}: {
  row: Extract<TranscriptRenderRow, { kind: 'timeline-item' | 'assistant-block' }>
  onRevert(entryId: string): void
  detail?: TranscriptDetailControl | undefined
}) {
  noteHistoricalTextRowBody(row.id)
  useNativeTheme()
  if (row.kind === 'assistant-block') {
    return (
      <TranscriptRowShell>
        <AssistantMessage item={row.item} source={row.source} showFooter={row.blockIndex === row.blockCount - 1} onRevert={onRevert} detail={row.blockIndex === row.blockCount - 1 ? detail : undefined} />
      </TranscriptRowShell>
    )
  }
  return <TimelineItemRow item={row.item} onRevert={onRevert} detail={detail} />
}, (previous, next) => previous.row === next.row && previous.detail?.stub === next.detail?.stub && previous.detail?.status === next.detail?.status)

const TraceHeaderRow = memo(function TraceHeaderRow({
  row,
  presenters,
  historyHasOlder,
  live,
  leasePreviewHeight,
  expanded,
  expandedEntryIds,
  onToggleTrace,
  onToggleEntry,
  onRevert,
  onDismissNotice,
  detail,
}: {
  row: Extract<TranscriptRenderRow, { kind: 'trace-header' }>
  presenters: ReadonlyMap<string, ToolPresenter>
  historyHasOlder: boolean
  live: boolean
  leasePreviewHeight(key: string, natural: number, hold: boolean): number
  expanded: boolean
  expandedEntryIds: ReadonlySet<string>
  onToggleTrace(traceId: string): void
  onToggleEntry(rowId: string): void
  onRevert(entryId: string): void
  onDismissNotice(id: number): void
  detail?: TranscriptDetailControl | undefined
}) {
  useNativeTheme()
  const running = live
  const inline = row.trace.items.length <= TRACE_INITIAL_PROJECTED_ROWS
  return (
    <TranscriptRowShell compact={running} noSelect>
      <ExecutionTraceHeader
        trace={row.trace}
        presenters={presenters}
        expanded={expanded}
        durationKnown={Boolean(row.trace.boundaryId) || !historyHasOlder}
        running={running}
        leasePreviewHeight={leasePreviewHeight}
        onToggle={() => onToggleTrace(row.id)}
        body={inline ? (
          <TraceEntries
            items={row.trace.items}
            traceId={row.id}
            presenters={presenters}
            expandedEntryIds={expandedEntryIds}
            onToggleEntry={onToggleEntry}
            onToggleTrace={onToggleTrace}
            onRevert={onRevert}
            onDismissNotice={onDismissNotice}
            detail={detail}
          />
        ) : null}
      />
    </TranscriptRowShell>
  )
}, (previous, next) => previous.row === next.row
  && previous.presenters === next.presenters
  && previous.historyHasOlder === next.historyHasOlder
  && previous.live === next.live
  && previous.leasePreviewHeight === next.leasePreviewHeight
  && previous.expanded === next.expanded
  && previous.expandedEntryIds === next.expandedEntryIds
  && previous.onToggleTrace === next.onToggleTrace
  && previous.onToggleEntry === next.onToggleEntry
  && previous.detail?.stub === next.detail?.stub
  && previous.detail?.status === next.detail?.status)

const TraceNoticesRow = memo(function TraceNoticesRow({
  notices,
  onDismissNotice,
}: {
  notices: Array<Extract<TraceTimelineItem, { kind: 'notice' }>>
  onDismissNotice(id: number): void
}) {
  return (
    <TranscriptRowShell compact>
      <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', marginLeft: 8, paddingLeft: 18, paddingTop: 5, paddingBottom: 5, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
        <TraceNotificationGroup items={notices} onDismiss={onDismissNotice} />
      </div>
    </TranscriptRowShell>
  )
}, (previous, next) => previous.notices === next.notices && previous.onDismissNotice === next.onDismissNotice)

const TraceFilesRow = memo(function TraceFilesRow({
  paths,
  onOpenDiff,
}: {
  paths: string[]
  onOpenDiff(): void
}) {
  return (
    <TranscriptRowShell compact>
      <div style={{ marginLeft: 26 }}><ChangedFilesCard paths={paths} onOpenDiff={onOpenDiff} /></div>
    </TranscriptRowShell>
  )
}, (previous, next) => previous.paths === next.paths && previous.onOpenDiff === next.onOpenDiff)

const TraceContinuationRow = memo(function TraceContinuationRow({ remaining }: { remaining: number }) {
  return (
    <TranscriptRowShell compact>
      <div testId="trace-projection-continuation" style={{ minHeight: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, marginLeft: 8, paddingLeft: 18, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
        <Icon name="circle" size={10} color={colors.textFaint} />
        <text style={{ color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{remaining === 1 ? 'Preparing 1 more entry…' : `Preparing ${remaining} more entries…`}</text>
      </div>
    </TranscriptRowShell>
  )
}, (previous, next) => previous.remaining === next.remaining)

const TraceEntryRow = memo(function TraceEntryRow({
  row,
  presenters,
  expanded,
  onToggleTrace,
  onToggleEntry,
  onRevert,
  detail,
}: {
  row: Extract<TranscriptRenderRow, { kind: 'trace-entry' }>
  presenters: ReadonlyMap<string, ToolPresenter>
  expanded: boolean
  onToggleTrace(traceId: string): void
  onToggleEntry(rowId: string): void
  onRevert(entryId: string): void
  detail?: TranscriptDetailControl | undefined
}) {
  return (
    <TranscriptRowShell compact>
      <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', marginLeft: 8, paddingLeft: 18, paddingTop: 5, paddingBottom: 5, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
        {row.item.kind === 'thinking'
          ? <TraceReasoning item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
          : row.item.kind === 'context-injection'
            ? <TraceContextInjection item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
            : row.item.kind === 'assistant'
              ? <TraceAssistant item={row.item} expanded={expanded} onToggle={() => onToggleEntry(row.id)} />
              : row.item.kind === 'compaction'
                ? <TraceCompaction item={row.item} expanded={expanded} onToggle={() => onToggleTrace(row.traceId)} />
                : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><div style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center' }}><text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650 }}>TOOL CALL</text></div><ToolRow item={row.item} presenters={presenters} expanded={expanded} onToggle={() => onToggleEntry(row.id)} onRevert={onRevert} />{detail && <DetailLoadControl detail={detail} />}</div>}
      </div>
    </TranscriptRowShell>
  )
}, (previous, next) => previous.row === next.row
  && previous.presenters === next.presenters
  && previous.expanded === next.expanded
  && previous.onToggleTrace === next.onToggleTrace
  && previous.onToggleEntry === next.onToggleEntry
  && previous.detail?.stub === next.detail?.stub
  && previous.detail?.status === next.detail?.status)

function TraceNotificationGroup({ items, onDismiss }: { items: Array<Extract<TraceTimelineItem, { kind: 'notice' }>>; onDismiss(id: number): void }) {
  return (
    <div testId="trace-notification-group" style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
      {items.map(({ notice }) => (
        <div key={notice.id} testId="trace-notification" style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650, whiteSpace: 'nowrap' }}>NOTIFICATION</text>
          <text style={{ minWidth: 0, flexGrow: 1, color: colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{notice.message}</text>
          <Timestamp value={notice.createdAt} />
          <div testId={`dismiss-trace-notification:${notice.id}`} tabIndex={0} style={{ width: 20, height: 20, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => onDismiss(notice.id)} onKeyDown={(event) => { if (event.key === 'enter') onDismiss(notice.id) }}>
            <Icon name="x" size={10} color={colors.textFaint} />
          </div>
        </div>
      ))}
    </div>
  )
}

function TimelineItemRow({ item, onRevert, detail }: { item: Exclude<DisplayTimelineItem, { kind: 'work-trace' }>; onRevert(entryId: string): void; detail?: TranscriptDetailControl | undefined }) {
  return (
    <TranscriptRowShell user={item.kind === 'user'}>
      {item.kind === 'user' && <UserMessage item={item} onRevert={onRevert} detail={detail} />}
      {item.kind === 'assistant' && <AssistantMessage item={item} onRevert={onRevert} detail={detail} />}
      {item.kind === 'status' && <StatusMessage text={item.text} error={item.tone === 'error'} timestamp={item.timestamp} />}
    </TranscriptRowShell>
  )
}

function TranscriptRowShell({ children, user = false, compact = false, noSelect = false }: { children: React.ReactNode; user?: boolean; compact?: boolean; noSelect?: boolean }) {
  const { contentGutter } = useResponsiveLayout()
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingTop: user ? 9 : compact ? 0 : 4, paddingBottom: user ? 11 : compact ? 0 : 7, paddingLeft: contentGutter, paddingRight: contentGutter, ...((compact || noSelect) ? { userSelect: 'none' as const } : {}) }}>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, minWidth: 0 }}>{children}</div>
    </div>
  )
}

// Pointer-only visuals stay native: React hover revisions make GPUI remeasure rows beneath a stationary cursor.
function UserMessage({ item, onRevert, detail }: { item: Extract<DisplayTimelineItem, { kind: 'user' }>; onRevert(entryId: string): void; detail?: TranscriptDetailControl | undefined }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div testId="user-message" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%', gap: 6 }}>
      {item.images.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', flexWrap: 'wrap', gap: 8, maxWidth: mobile ? '92%' : '80%' }}>
          {item.images.map((image, index) => <MessageImage key={`${item.id}-image-${index}`} image={image} />)}
        </div>
      )}
      {item.text && (
        <div style={{ maxWidth: mobile ? '92%' : '80%', paddingTop: 10, paddingBottom: 10, paddingLeft: 13, paddingRight: 13, borderRadius: 16, backgroundColor: colors.message }}>
          <text testId="user-message-text" style={{ color: colors.text, fontSize: 14, lineHeight: 21, whiteSpace: 'normal' }}>{item.text}</text>
        </div>
      )}
      {detail && <DetailLoadControl detail={detail} />}
      <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} align="end" onRevert={onRevert} />
    </div>
  )
}

function AssistantMessage({
  item,
  onRevert,
  source,
  showFooter = true,
  detail,
}: {
  item: Extract<DisplayTimelineItem, { kind: 'assistant' }>
  onRevert(entryId: string): void
  source?: string
  showFooter?: boolean
  detail?: TranscriptDetailControl | undefined
}) {
  const markdownSource = useThrottledMarkdownSource((source ?? item.text) || '…', Boolean(item.streaming) && source === undefined)
  return (
    <div testId="assistant-message" style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 5, paddingLeft: 4, paddingRight: 4 }}>
      <MathMarkdown
        testId="assistant-message-markdown"
        source={markdownSource}
        theme={nativeTheme}
        style={{ width: '100%', minWidth: 0 }}
        onLinkClick={(event) => openExternal(String(event.value ?? ''))}
      />
      {detail && <DetailLoadControl detail={detail} />}
      {showFooter && !item.streaming && item.metrics && <AnsiText testId="response-usage" text={item.metrics} />}
      {showFooter && !item.streaming && <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} align="start" onRevert={onRevert} />}
    </div>
  )
}

const TRACE_CHEVRON_SOURCE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>'

function TraceChevron({ expanded, size = 12 }: { expanded: boolean; size?: number }) {
  return React.createElement('svg', {
    source: TRACE_CHEVRON_SOURCE,
    rotation: expanded ? 90 : 0,
    style: { width: size, height: size, flexShrink: 0, color: colors.textFaint, pointerEvents: 'none' },
  } as never)
}

function ExecutionTraceHeader({
  trace,
  presenters,
  expanded,
  durationKnown,
  running,
  leasePreviewHeight,
  onToggle,
  body,
}: {
  trace: Extract<DisplayTimelineItem, { kind: 'work-trace' }>
  presenters: ReadonlyMap<string, ToolPresenter>
  expanded: boolean
  durationKnown: boolean
  running: boolean
  leasePreviewHeight(key: string, natural: number, hold: boolean): number
  onToggle(): void
  body?: React.ReactNode
}) {
  const label = workTraceLabel(trace, running, durationKnown)
  const wave = currentWorkWave(trace.items)
  const collapsedTools = running && !expanded ? wave.tools.slice(-COLLAPSED_TRACE_TOOL_LIMIT) : []
  const preview = wave.preview && wave.preview.kind !== 'tool' ? wave.preview : undefined
  const naturalHeight = !expanded && running ? Math.max(COLLAPSED_TRACE_ROW_HEIGHT, collapsedPreviewHeight(collapsedTools, preview, presenters)) : 0
  const leasedHeight = leasePreviewHeight(trace.boundaryId ?? trace.items[0]?.id ?? trace.id, naturalHeight, running)
  const extraHeight = Math.max(0, leasedHeight - naturalHeight)
  const height = leasedHeight
  return (
    <div testId="execution-trace" style={{ position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', gap: 2, paddingLeft: 4, paddingRight: 2, userSelect: 'none' }}>
      <div
        testId="tool-row"
        tabIndex={0}
        style={{ position: 'relative', height: 24, minHeight: 24, overflow: 'hidden', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none', backgroundColor: colors.background }}
        onKeyDown={(event) => { if (event.key === 'enter') onToggle() }}
      >
        {running
          ? <TextShimmer testId="execution-trace-label" text="Working" fontSize={13} baseColor={colors.textMuted} highlightColor={colors.text} />
          : <text testId="execution-trace-label" style={{ color: colors.textMuted, fontSize: 13, userSelect: 'none', pointerEvents: 'none' }}>{label}</text>}
        <TraceChevron expanded={expanded} />
      </div>
      {!expanded && (
        <WorkPreviewTransition height={height}>
          {running && preview && <TracePreview item={preview} />}
          {running && collapsedTools.length > 0 ? <CollapsedTraceTools items={collapsedTools} presenters={presenters} hidden={Math.max(0, wave.tools.length - collapsedTools.length)} /> : null}
          {running && extraHeight > 0 && <div testId="transcript-lease" style={{ width: '100%', height: extraHeight }} />}
        </WorkPreviewTransition>
      )}
      {body && (
        <TraceExpandBody open={expanded}>
          {body}
        </TraceExpandBody>
      )}
      <div testId="execution-trace-hit" style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 24, cursor: 'pointer', backgroundColor: '#00000001' }} onClick={onToggle} />
    </div>
  )
}

function TraceExpandBody({ open, children }: { open: boolean; children: React.ReactNode }) {
  if (!open) return null
  return (
    <div testId="execution-trace-body" style={{ overflow: 'hidden', flexShrink: 0 }}>
      {children}
    </div>
  )
}

function TraceEntries({
  items,
  traceId,
  presenters,
  expandedEntryIds,
  onToggleEntry,
  onToggleTrace,
  onRevert,
  onDismissNotice,
  detail,
}: {
  items: readonly TraceTimelineItem[]
  traceId: string
  presenters: ReadonlyMap<string, ToolPresenter>
  expandedEntryIds: ReadonlySet<string>
  onToggleEntry(rowId: string): void
  onToggleTrace(traceId: string): void
  onRevert(entryId: string): void
  onDismissNotice(id: number): void
  detail?: TranscriptDetailControl | undefined
}) {
  return (
    <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', flexShrink: 0, marginLeft: 8, paddingLeft: 18, paddingTop: 5, paddingBottom: 5, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
      {items.map((item) => {
        const rowId = `${traceId}:entry:${item.id}`
        const expanded = item.kind === 'compaction' ? true : expandedEntryIds.has(rowId)
        return (
          <div key={item.id} style={{ paddingTop: 5, paddingBottom: 5 }}>
            {item.kind === 'thinking'
              ? <TraceReasoning item={item} expanded={expanded} onToggle={() => onToggleEntry(rowId)} />
              : item.kind === 'context-injection'
                ? <TraceContextInjection item={item} expanded={expanded} onToggle={() => onToggleEntry(rowId)} />
                : item.kind === 'assistant'
                  ? <TraceAssistant item={item} expanded={expanded} onToggle={() => onToggleEntry(rowId)} />
                  : item.kind === 'compaction'
                    ? <TraceCompaction item={item} expanded={expanded} onToggle={() => onToggleTrace(traceId)} />
                    : item.kind === 'notice'
                      ? <TraceNotificationGroup items={[item]} onDismiss={onDismissNotice} />
                      : <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><div style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center' }}><text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650 }}>TOOL CALL</text></div><ToolRow item={item} presenters={presenters} expanded={expanded} onToggle={() => onToggleEntry(rowId)} onRevert={onRevert} />{detail && detail.stub.entryId === item.tool.id && (detail.status || detail.stub.bytes > TRANSCRIPT_DETAIL_AUTO_MAX_BYTES) && <DetailLoadControl detail={detail} />}</div>}
          </div>
        )
      })}
    </div>
  )
}

export function WorkPreviewTransition({ height, children }: { height: number; children: React.ReactNode }) {
  const entered = useRef(false)
  const initial = entered.current ? false : { opacity: 0, top: 4 }
  entered.current = true
  return (
    <MotionDiv testId="execution-preview-transition" initial={initial} animate={{ opacity: 1, top: 0 }} transition={READING_LAYOUT_TRANSITION} style={{ position: 'relative', overflow: 'hidden', height, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', gap: 2 }}>
      {children}
    </MotionDiv>
  )
}

function TraceReasoning({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'thinking' }>; expanded: boolean; onToggle(): void }) {
  return <TraceDisclosure label="REASONING" text={item.text} testId="trace-reasoning" streaming={Boolean(item.streaming)} expanded={expanded} onToggle={onToggle} />
}

function TraceCompaction({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'compaction' }>; expanded: boolean; onToggle(): void }) {
  return <TraceDisclosure label="COMPACTION" text={item.text} testId="trace-compaction" expanded={expanded} onToggle={onToggle} />
}

function TraceAssistant({ item, expanded, onToggle }: { item: AssistantTimelineItem; expanded: boolean; onToggle(): void }) {
  return <TraceDisclosure label="RESPONSE" text={item.text} testId="trace-assistant" streaming={Boolean(item.streaming)} expanded={expanded} onToggle={onToggle} />
}

function TraceContextInjection({ item, expanded, onToggle }: { item: Extract<TimelineItem, { kind: 'context-injection' }>; expanded: boolean; onToggle(): void }) {
  if (item.source === 'turn metrics') return <AnsiText testId="response-telemetry" text={item.text} />
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <TraceDisclosure label={contextInjectionLabel(item)} text={item.text || `${item.images.length} image${item.images.length === 1 ? '' : 's'}`} testId="trace-context-injection" expanded={expanded} onToggle={onToggle} />
      {expanded && item.images.length > 0 && (
        <div testId="context-injection-images" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
          {item.images.map((image, index) => React.createElement('img', {
            key: `${item.id}-image-${index}`,
            src: messageImageSrc(image),
            alt: `${item.source ?? 'Extension'} image ${index + 1}`,
            objectFit: 'contain',
            style: { maxWidth: '100%', maxHeight: 220, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background },
          } as never))}
        </div>
      )}
    </div>
  )
}

function TraceDisclosure({ label, text, testId, expanded, onToggle }: { label: string; text: string; testId: string; streaming?: boolean; expanded: boolean; onToggle(): void }) {
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div testId={`${testId}-toggle`} tabIndex={0} style={{ position: 'relative', minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none', backgroundColor: colors.background }} onKeyDown={(event) => { if (event.key === 'enter') onToggle() }}>
        <text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650, whiteSpace: 'nowrap', pointerEvents: 'none', hover: { color: colors.textMuted } }}>{label}</text>
        {!expanded && <text testId={`${testId}-preview`} style={{ minWidth: 0, flexGrow: 1, color: colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis', pointerEvents: 'none' }}>{markdownPreview(text)}</text>}
        <TraceChevron expanded={expanded} size={10} />
        <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, cursor: 'pointer', backgroundColor: '#00000001' }} onClick={onToggle} />
      </div>
      {expanded && (
        <MathMarkdown
          testId={`${testId}-markdown`}
          source={text}
          theme={traceMarkdownTheme()}
          style={{ width: '100%', minWidth: 0, overflow: 'visible', userSelect: 'none', pointerEvents: 'none' }}
          onLinkClick={(event) => openExternal(String(event.value ?? ''))}
        />
      )}
    </div>
  )
}

function TracePreview({ item }: { item: TraceTimelineItem }) {
  if (item.kind === 'thinking' || item.kind === 'assistant') {
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(item.text)}</text></div>
  }
  if (item.kind === 'context-injection') {
    const prefix = item.source ? `${contextInjectionLabel(item)} ` : ''
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(`${prefix}${item.text}`)}</text></div>
  }
  if (item.kind === 'notice') {
    return <div testId="execution-preview" style={{ minWidth: 0, overflow: 'hidden', paddingLeft: 1 }}><text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.notice.message}</text></div>
  }
  if (item.kind === 'compaction') {
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

function contextInjectionLabel(item: Extract<TimelineItem, { kind: 'context-injection' }>): string {
  return item.source ? item.source.replace(/\[|\]/g, '').toUpperCase() : 'CONTEXT INJECTION'
}

function CollapsedTraceTools({ items, hidden, presenters }: { items: Array<Extract<TraceTimelineItem, { kind: 'tool' }>>; hidden: number; presenters: ReadonlyMap<string, ToolPresenter> }) {
  return (
    <div testId="collapsed-trace-tools" style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingLeft: 1 }}>
      {items.map((item) => {
        const presentation = resolveToolPresentation(item.tool, presenters)
        const label = presentation.fabric?.name || presentation.title || toolSummary(item.tool)
        return (
          <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div testId="collapsed-trace-tool" style={{ minHeight: 19, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
              <text style={{ width: 10, color: item.tool.isError ? colors.error : item.tool.status === 'complete' ? colors.textFaint : colors.warning, fontSize: 11 }}>{item.tool.isError ? '×' : item.tool.status === 'complete' ? '›' : '•'}</text>
              <text style={{ width: 0, minWidth: 0, flexGrow: 1, overflow: 'hidden', color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{label}</text>
            </div>
            {presentation.fabric && presentation.fabric.audits.length > 0 && <FabricCollapsedCalls audits={presentation.fabric.audits} compact />}
          </div>
        )
      })}
      {hidden > 0 && <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>{`… ${hidden} tool ${hidden === 1 ? 'call' : 'calls'} hidden`}</text>}
    </div>
  )
}

function RetiringAssistantRow({ item, onRevert, onDone }: { item: AssistantTimelineItem; onRevert(entryId: string): void; onDone(): void }) {
  const [open, setOpen] = useState(true)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  useEffect(() => {
    const timer = setTimeout(() => setOpen(false), 16)
    return () => clearTimeout(timer)
  }, [])
  const height = open ? RETIRING_ASSISTANT_HEIGHT : 0
  useEffect(() => {
    if (open) return
    const timer = setTimeout(() => onDoneRef.current(), SPRING_SETTLE_MS)
    return () => clearTimeout(timer)
  }, [open])
  return (
    <TranscriptRowShell>
      <MotionDiv
        testId="retiring-assistant"
        initial={{ opacity: 1, top: 0 }}
        animate={{ opacity: open ? 1 : 0, top: open ? 0 : -8 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        style={{ position: 'relative', overflow: 'hidden', height: Math.max(0, height), width: '100%' }}
      >
        <AssistantMessage item={{ ...item, streaming: false }} onRevert={onRevert} />
      </MotionDiv>
    </TranscriptRowShell>
  )
}

function collapsedPreviewHeight(
  tools: Array<Extract<TraceTimelineItem, { kind: 'tool' }>>,
  preview: TraceTimelineItem | undefined,
  presenters: ReadonlyMap<string, ToolPresenter>,
): number {
  let rows = preview && preview.kind !== 'tool' ? 1 : 0
  for (const item of tools) {
    rows += 1
    const fabric = resolveToolPresentation(item.tool, presenters).fabric
    if (!fabric || fabric.audits.length === 0) continue
    const visible = Math.min(fabric.audits.length, COLLAPSED_TRACE_TOOL_LIMIT)
    rows += visible + (fabric.audits.length > visible ? 1 : 0)
  }
  return rows * COLLAPSED_TRACE_ROW_HEIGHT
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

function MessageImage({ image }: { image: PiImageContent }) {
  const src = messageImageSrc(image)
  return (
    <div style={{ width: 156, height: 104, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, overflow: 'hidden' }}>
      {src
        ? React.createElement('img', { src, alt: 'Attached image', objectFit: 'cover', style: { width: 156, height: 104 } } as never)
        : <text style={{ color: colors.textFaint, fontSize: 11 }}>Attached image</text>}
    </div>
  )
}

function DetailLoadControl({ detail }: { detail: TranscriptDetailControl }) {
  const bytes = detail.stub.bytes
  const label = bytes > 0 ? `Load full output (${Math.max(1, Math.round(bytes / 1024))} KB)` : 'Load full output'
  if (detail.status === 'loading') {
    return <text testId="transcript-detail-loading" style={{ color: colors.textFaint, fontSize: 11 }}>Loading full output…</text>
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
      <div
        testId="transcript-load-detail"
        tabIndex={0}
        style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 6, borderWidth: 1, borderColor: colors.borderStrong, cursor: 'pointer', hover: { backgroundColor: colors.hover } }}
        onClick={() => { void detail.onLoad(detail.stub.entryId) }}
        onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') void detail.onLoad(detail.stub.entryId) }}
      >
        <text style={{ color: colors.textMuted, fontSize: 11 }}>{label}</text>
      </div>
      {detail.status === 'error' && <text testId="transcript-detail-error" style={{ color: colors.error, fontSize: 11 }}>Couldn’t load full output</text>}
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
  const copyResetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => {
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
  }, [])
  const copy = async () => {
    if (!await copyTextToClipboard(copyText)) return
    if (copyResetTimer.current) clearTimeout(copyResetTimer.current)
    setCopied(true)
    copyResetTimer.current = setTimeout(() => {
      copyResetTimer.current = undefined
      setCopied(false)
    }, 900)
  }
  const actions = (
    <>
      {revertEntryId && <TranscriptInlineAction icon="gitBranch" testId="tree-message" onClick={() => onRevert(revertEntryId)} />}
      {copyText && <TranscriptInlineAction icon={copied ? 'check' : 'copy'} testId="copy-message" onClick={() => void copy()} />}
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

function WorkingRow({ activity: _activity }: { activity: string }) {
  const { contentGutter } = useResponsiveLayout()
  return (
    <div testId="working-row" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingLeft: contentGutter, paddingRight: contentGutter, paddingTop: 2, paddingBottom: 8 }}>
      <div style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 5 }}>
        <TextShimmer text="Working" fontSize={13} baseColor={colors.textMuted} highlightColor={colors.text} />
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
  const { contentGutter } = useResponsiveLayout()
  const project = workspaceDisplayName(workspacePath)
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', paddingLeft: contentGutter, paddingRight: contentGutter, paddingBottom: 190 }}>
      <div style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 9 }}>
        <text style={{ color: colors.text, fontSize: 26, fontWeight: 500 }}>{`What should we build in ${project}?`}</text>
      </div>
    </div>
  )
}

function ComposerSpacer({ questionnaireCollapsed, queue, statusItems, widgets }: { questionnaireCollapsed: boolean; queue: WorkbenchState['queue']; statusItems: WorkbenchState['statusItems']; widgets: WorkbenchState['widgets'] }) {
  const targetHeight = 194 + questionnaireWaitingDockReserveHeight(questionnaireCollapsed) + queueDockReserveHeight(queue) + extensionSurfaceRailReserveHeight(widgets, statusItems)
  return <div testId="composer-spacer" style={{ width: '100%', height: targetHeight }} />
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


function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}
