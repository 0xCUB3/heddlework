import React, { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useGpuixRequired, type StyleDesc } from '@gpuix/react'
import type { PiImageContent, PiMessage } from '../pi/types.ts'
import type { WorkbenchState, ToolRun } from '../workbench/state.ts'
import { buildTimeline, type TimelineItem } from '../workbench/timeline.ts'
import { Icon, type IconName } from './icons.tsx'
import { colors, nativeTheme } from './theme.ts'
import { openExternal } from './open-external.ts'
import { copyTextToClipboard, hydrateMessageImages } from './clipboard-media.ts'
import { NativeVirtualList, type NativeElementHandle, type NativeVisibleRangeEvent } from './primitives.tsx'
import { composerNotificationStackHeight } from './notifications.tsx'
import { queueDockReserveHeight } from './queue-dock.tsx'
import { resolveToolPresentation, type FabricAuditPresentation, type FabricToolPresentation, type ToolPresenter } from './tool-presenters.ts'

const MAX_TOOL_OUTPUT = 24_000
const HISTORY_PREFETCH_ROWS = 8
const MAX_HISTORY_NO_PROGRESS_PAGES = 8
const HISTORY_SKELETON_HEIGHT = 132
const CODE_SURFACE_STYLE = {
  width: '100%',
  paddingTop: 10,
  paddingRight: 12,
  paddingBottom: 10,
  paddingLeft: 12,
  borderRadius: 9,
  borderWidth: 1,
  borderColor: colors.border,
  backgroundColor: colors.code,
} satisfies StyleDesc

const TRACE_MARKDOWN_THEME = {
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

const FABRIC_COLLAPSED_CALL_LIMIT = 8

type TraceTimelineItem = Extract<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' }>

type DisplayTimelineItem = Exclude<TimelineItem, { kind: 'thinking' | 'context-injection' | 'tool' }> | {
  id: string
  kind: 'work-trace'
  items: TraceTimelineItem[]
  revertEntryId?: string
}

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
  const renderer = useGpuixRequired()
  const listRef = useRef<NativeElementHandle | null>(null)
  const paging = useRef(false)
  const visibleStartIndex = useRef<number | undefined>(undefined)
  const pendingHistoryPage = useRef<{ anchorId: string | undefined; continuation: number } | undefined>(undefined)
  const sessionKey = state.session.sessionFile ?? state.session.sessionId ?? state.workspacePath
  useEffect(() => {
    paging.current = false
  }, [sessionKey, state.messages.length, state.messagesLoadingEarlier])
  useEffect(() => {
    pendingHistoryPage.current = undefined
    visibleStartIndex.current = undefined
  }, [sessionKey])

  const hydratedMessages = useMemo(() => hydrateMessageImages(state.messages), [state.messages])
  const items = useMemo(
    () => groupWorkItems(buildTimeline(hydratedMessages, state.liveAssistant, state.liveTools, state.forkMessages)),
    [hydratedMessages, state.forkMessages, state.liveAssistant, state.liveTools],
  )
  const usesStaticShortScroller = !state.session.isStreaming && !state.messagesHasOlder && state.messages.length >= 8 && state.messages.length <= 40
  useEffect(() => {
    if (!usesStaticShortScroller) return
    queueMicrotask(() => {
      const elementId = listRef.current?.id
      if (elementId !== undefined) renderer.scrollTo?.(elementId, 0, -1_000_000_000)
    })
  }, [items, renderer, sessionKey, state.notices.length, state.queue, usesStaticShortScroller])
  const loadEarlier = (continuation = 0) => {
    if (!onLoadEarlier || !state.messagesHasOlder || state.messagesLoadingEarlier || paging.current) return
    paging.current = true
    pendingHistoryPage.current = { anchorId: items[0]?.id, continuation }
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
    const firstMessageRow = Math.max(0, Math.floor(event.startIndex) - (state.messagesLoadingEarlier ? 1 : 0))
    visibleStartIndex.current = firstMessageRow
    if (firstMessageRow <= HISTORY_PREFETCH_ROWS) loadEarlier()
  }
  // A disk page can fold entirely into the collapsed first trace and add no scrollable row.
  useEffect(() => {
    if (state.messagesLoadingEarlier) return
    const pending = pendingHistoryPage.current
    if (!pending) return
    pendingHistoryPage.current = undefined
    const anchorIndex = pending.anchorId ? items.findIndex((item) => item.id === pending.anchorId) : -1
    if (
      anchorIndex === 0
      && state.messagesHasOlder
      && (visibleStartIndex.current ?? HISTORY_PREFETCH_ROWS + 1) <= HISTORY_PREFETCH_ROWS
      && pending.continuation + 1 < MAX_HISTORY_NO_PROGRESS_PAGES
    ) {
      queueMicrotask(() => loadEarlier(pending.continuation + 1))
    }
  }, [items, state.messagesHasOlder, state.messagesLoadingEarlier])

  const transcriptContent = (
    <>
      {state.messagesLoadingEarlier && <HistoryLoadingSkeleton />}
      {items.length === 0 ? (
        <EmptyConversation workspacePath={state.workspacePath} />
      ) : items.map((item) => (
        <TimelineRow key={item.id} item={item} presenters={presenters} onOpenDiff={onOpenDiff} onRevert={onRevert} />
      ))}
      {state.session.isStreaming && !items.some((item) => item.kind === 'work-trace' && item.items.some((entry) => entry.kind === 'thinking' ? entry.streaming : entry.kind === 'tool' ? entry.tool.status !== 'complete' : false)) && <WorkingRow activity={state.activity} />}
      <ComposerSpacer noticeCount={state.notices.length} queue={state.queue} />
    </>
  )

  // Keyed children let GPUIX preserve the native row anchor when history prepends.
  return (
    <div testId="transcript-scroll-surface" style={{ position: 'relative', flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
      {usesStaticShortScroller ? (
        <div
          key={`${sessionKey}:static`}
          testId="transcript-list"
          ref={(element) => { listRef.current = element }}
          style={{ height: 0, flexGrow: 1, minHeight: 0, width: '100%', display: 'flex', flexDirection: 'column', overflow: 'scroll' }}
        >
          <div style={{ width: '100%', display: 'flex', flexDirection: 'column', flexShrink: 0 }}>{transcriptContent}</div>
        </div>
      ) : (
        <NativeVirtualList
          key={`${sessionKey}:virtual`}
          testId="transcript-list"
          elementRef={listRef}
          alignment="bottom"
          followTail
          onVisibleRange={handleVisibleRange}
          overdraw={240}
          estimatedItemHeight={108}
          style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
        >
          {transcriptContent}
        </NativeVirtualList>
      )}
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
  && previous.state.queue === next.state.queue)

function HistoryLoadingSkeleton() {
  return (
    <div
      testId="history-loading-skeleton"
      style={{
        width: '100%',
        height: HISTORY_SKELETON_HEIGHT,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'center',
        paddingTop: 20,
        paddingRight: 20,
        paddingBottom: 18,
        paddingLeft: 20,
      }}
    >
      <div style={{ width: '100%', maxWidth: 768, display: 'flex', flexDirection: 'column', gap: 10, padding: 12, borderRadius: 10, backgroundColor: colors.card }}>
        <div style={{ width: 92, height: 7, borderRadius: 4, backgroundColor: colors.borderStrong, opacity: 0.72 }} />
        <div style={{ width: '72%', height: 9, borderRadius: 5, backgroundColor: colors.raised }} />
        <div style={{ width: '54%', height: 9, borderRadius: 5, backgroundColor: colors.raised, opacity: 0.82 }} />
      </div>
    </div>
  )
}

function TimelineRow({ item, presenters, onOpenDiff, onRevert }: { item: DisplayTimelineItem; presenters: ReadonlyMap<string, ToolPresenter>; onOpenDiff(): void; onRevert(entryId: string): void }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'center',
        width: '100%',
        paddingTop: item.kind === 'user' ? 9 : 4,
        paddingBottom: item.kind === 'user' ? 11 : 7,
        paddingLeft: 20,
        paddingRight: 20,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, minWidth: 0 }}>
        {item.kind === 'user' && <UserMessage item={item} onRevert={onRevert} />}
        {item.kind === 'assistant' && <AssistantMessage item={item} onRevert={onRevert} />}
        {item.kind === 'work-trace' && <ExecutionTrace items={item.items} presenters={presenters} onOpenDiff={onOpenDiff} onRevert={onRevert} />}
        {item.kind === 'status' && <StatusMessage text={item.text} error={item.tone === 'error'} timestamp={item.timestamp} />}
      </div>
    </div>
  )
}

function UserMessage({ item, onRevert }: { item: Extract<DisplayTimelineItem, { kind: 'user' }>; onRevert(entryId: string): void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div testId="user-message" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%', gap: 6 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
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
      <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} hovered={hovered} align="end" onRevert={onRevert} />
    </div>
  )
}

function AssistantMessage({ item, onRevert }: { item: Extract<DisplayTimelineItem, { kind: 'assistant' }>; onRevert(entryId: string): void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div testId="assistant-message" style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 5, paddingLeft: 4, paddingRight: 4 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
      <markdown
        source={item.text || '…'}
        theme={nativeTheme}
        style={{ width: '100%', minWidth: 0 }}
        onLinkClick={(event) => openExternal(String(event.value ?? ''))}
      />
      {item.streaming
        ? <text style={{ color: colors.textFaint, fontSize: 10 }}>streaming</text>
        : <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} hovered={hovered} align="start" onRevert={onRevert} />}
    </div>
  )
}

function ExecutionTrace({ items, presenters, onOpenDiff, onRevert }: { items: TraceTimelineItem[]; presenters: ReadonlyMap<string, ToolPresenter>; onOpenDiff(): void; onRevert(entryId: string): void }) {
  const tools = items.filter((item): item is Extract<TimelineItem, { kind: 'tool' }> => item.kind === 'tool')
  const running = items.some((item) => item.kind === 'thinking' ? item.streaming : item.kind === 'tool' ? item.tool.status !== 'complete' : false)
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  const changedPaths = [...new Set(tools.flatMap((item) => changedPath(item.tool) ? [changedPath(item.tool)!] : []))]
  const preview = items.at(-1)
  return (
    <div testId="execution-trace" style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 5, paddingLeft: 4, paddingRight: 2 }}>
      <div
        testId="tool-row"
        tabIndex={0}
        style={{ minHeight: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'enter') setExpanded((value) => !value) }}
      >
        <text testId="execution-trace-label" style={{ color: hovered ? colors.text : colors.textMuted, fontSize: 13 }}>{running ? 'Working' : `Worked for ${traceDuration(items)}`}</text>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={hovered ? colors.textMuted : colors.textFaint} />
      </div>
      {!expanded && running && preview && <TracePreview item={preview} />}
      {expanded && (
        <div testId="execution-timeline" style={{ display: 'flex', flexDirection: 'column', gap: 14, marginLeft: 8, paddingLeft: 18, paddingTop: 6, paddingBottom: 8, borderLeftWidth: 1, borderColor: colors.borderStrong }}>
          {items.map((item) => item.kind === 'thinking'
            ? <TraceReasoning key={item.id} item={item} />
            : item.kind === 'context-injection'
              ? <TraceContextInjection key={item.id} item={item} />
              : <div key={item.id} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}><text style={{ color: colors.textFaint, fontSize: 9, fontWeight: 650 }}>TOOL CALL</text><ToolRow item={item} presenters={presenters} onRevert={onRevert} /></div>)}
        </div>
      )}
      {changedPaths.length > 0 && <ChangedFilesCard paths={changedPaths} onOpenDiff={onOpenDiff} />}
    </div>
  )
}

function TraceReasoning({ item }: { item: Extract<TimelineItem, { kind: 'thinking' }> }) {
  return <TraceDisclosure label="REASONING" text={item.text} testId="trace-reasoning" streaming={Boolean(item.streaming)} />
}

function TraceContextInjection({ item }: { item: Extract<TimelineItem, { kind: 'context-injection' }> }) {
  return <TraceDisclosure label="CONTEXT INJECTION" text={item.text} testId="trace-context-injection" />
}

function TraceDisclosure({ label, text, testId, streaming = false }: { label: string; text: string; testId: string; streaming?: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const [hovered, setHovered] = useState(false)
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div testId={`${testId}-toggle`} tabIndex={0} style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer' }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onClick={() => setExpanded((value) => !value)} onKeyDown={(event) => { if (event.key === 'enter') setExpanded((value) => !value) }}>
        <text style={{ color: hovered ? colors.textMuted : colors.textFaint, fontSize: 9, fontWeight: 650, whiteSpace: 'nowrap' }}>{label}</text>
        {!expanded && <text testId={`${testId}-preview`} style={{ minWidth: 0, flexGrow: 1, color: colors.textFaint, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{markdownPreview(text)}</text>}
        {streaming && <text style={{ color: colors.info, fontSize: 9 }}>LIVE</text>}
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={10} color={colors.textFaint} />
      </div>
      {expanded && (
        <markdown
          testId={`${testId}-markdown`}
          source={text}
          theme={TRACE_MARKDOWN_THEME}
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

function ToolRow({ item, presenters, onRevert }: { item: Extract<TimelineItem, { kind: 'tool' }>; presenters: ReadonlyMap<string, ToolPresenter>; onRevert(entryId: string): void }) {
  const tool = item.tool
  const [hovered, setHovered] = useState(false)
  const [expanded, setExpanded] = useState(false)
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
    setExpanded((value) => !value)
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
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
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
        <text testId="tool-summary-label" style={{ color: hovered ? colors.text : colors.textMuted, fontSize: 12, minWidth: 0, flexShrink: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontMono }}>{summary}</text>
        <div style={{ flexGrow: 1 }} />
        {hovered && <InlineAction icon="copy" testId="copy-tool" onClick={() => runInlineAction(() => { void copyTextToClipboard(toolCopyText(tool, args, content)) })} />}
        {hovered && item.revertEntryId && <InlineAction icon="undo" testId="revert-tool" onClick={() => runInlineAction(() => onRevert(item.revertEntryId!))} />}
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
          {args && <code code={args} language="json" theme={nativeTheme} style={CODE_SURFACE_STYLE} />}
          {content ? (
            presentation.kind === 'diff'
              ? <diff patch={content} wordDiff maxLines={500} theme={nativeTheme} style={{ width: '100%', fontFamily: nativeTheme.fontMono }} />
              : (
                <code
                  code={content}
                  theme={nativeTheme}
                  style={CODE_SURFACE_STYLE}
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
  return (
    <div testId="fabric-tool-body" style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 9, paddingLeft: 31, paddingTop: 5, paddingBottom: 8 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: 11, borderRadius: 10, borderWidth: 1, borderColor: '#313543', backgroundColor: '#141722' }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <Icon name="sparkles" size={14} color={colors.info} />
          <text style={{ color: colors.text, fontSize: 12, fontWeight: 650, fontFamily: nativeTheme.fontMono }}>{fabric.name}</text>
          <div style={{ flexGrow: 1 }} />
          <text style={{ color: colors.textFaint, fontSize: 9, fontFamily: nativeTheme.fontMono }}>{`TypeScript · ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}</text>
        </div>
        {fabric.description && <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17, fontFamily: nativeTheme.fontMono }}>{fabric.description}</text>}
      </div>
      {fabric.code && <code code={fabric.code} language="typescript" theme={nativeTheme} style={CODE_SURFACE_STYLE} />}
      {fabric.audits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {fabric.audits.map((audit, index) => <FabricAuditCard key={`${audit.ref}-${index}`} audit={audit} />)}
        </div>
      )}
      {output && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, fontFamily: nativeTheme.fontMono }}>RESULT</text>
          <code code={output} language={fabric.outputLanguage ?? 'text'} theme={nativeTheme} style={CODE_SURFACE_STYLE} />
        </div>
      )}
    </div>
  )
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
      {audit.args && <code code={formatFabricValue(audit.args)} language="json" theme={nativeTheme} style={CODE_SURFACE_STYLE} />}
      {result && (
        <code
          code={result}
          theme={nativeTheme}
          style={CODE_SURFACE_STYLE}
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
  hovered,
  align,
  onRevert,
}: {
  timestamp?: number | undefined
  copyText: string
  revertEntryId?: string | undefined
  hovered: boolean
  align: 'start' | 'end'
  onRevert(entryId: string): void
}) {
  const [copied, setCopied] = useState(false)
  const [footerHovered, setFooterHovered] = useState(false)
  const copy = async () => {
    if (!await copyTextToClipboard(copyText)) return
    setCopied(true)
    setTimeout(() => setCopied(false), 900)
  }
  const actions = hovered || footerHovered ? (
    <>
      {revertEntryId && <InlineAction icon="gitBranch" testId="fork-message" onClick={() => onRevert(revertEntryId)} />}
      {copyText && <InlineAction icon={copied ? 'check' : 'copy'} testId="copy-message" onClick={() => void copy()} />}
    </>
  ) : null
  return (
    <div testId="message-footer" style={{ minHeight: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: align === 'end' ? 'flex-end' : 'flex-start', gap: 5 }} onMouseEnter={() => setFooterHovered(true)} onMouseLeave={() => setFooterHovered(false)}>
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
    <div style={{ padding: 8, borderRadius: 7, backgroundColor: error ? '#261418' : colors.card }}>
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

function ComposerSpacer({ noticeCount, queue }: { noticeCount: number; queue: WorkbenchState['queue'] }) {
  return <div testId="composer-spacer" style={{ width: '100%', height: 194 + composerNotificationStackHeight(noticeCount) + queueDockReserveHeight(queue) }} />
}

function Timestamp({ value }: { value: number }) {
  return <text style={{ color: colors.textFaint, fontSize: 9 }}>{formatTimestamp(value)}</text>
}

function groupWorkItems(items: TimelineItem[]): DisplayTimelineItem[] {
  const grouped: DisplayTimelineItem[] = []
  for (const item of items) {
    if (item.kind !== 'thinking' && item.kind !== 'context-injection' && item.kind !== 'tool') {
      grouped.push(item)
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'work-trace') {
      previous.items.push(item)
      previous.id = `work-trace-${item.id}`
      if (item.revertEntryId) previous.revertEntryId = item.revertEntryId
    } else {
      grouped.push({ id: `work-trace-${item.id}`, kind: 'work-trace', items: [item], ...(item.revertEntryId ? { revertEntryId: item.revertEntryId } : {}) })
    }
  }
  return grouped
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

function changedPath(tool: ToolRun): string | undefined {
  if (tool.name !== 'edit' && tool.name !== 'write') return undefined
  const args = tool.args && typeof tool.args === 'object' ? tool.args as Record<string, unknown> : {}
  return typeof args.path === 'string' ? args.path : undefined
}

function traceDuration(tools: Array<Pick<TimelineItem, 'timestamp'>>): string {
  const timestamps = tools.map((item) => item.timestamp).filter((value): value is number => typeof value === 'number')
  if (timestamps.length > 1) return `${Math.max(1, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1_000))}s`
  return `${Math.max(1, tools.length)}s`
}

function workSummary(commands: number, tools: number): string {
  const parts: string[] = []
  if (commands > 0) parts.push(`Ran ${commands} ${commands === 1 ? 'command' : 'commands'}`)
  if (tools > 0) parts.push(`used ${tools} ${tools === 1 ? 'tool' : 'tools'}`)
  return parts.join(' and ') || 'Completed agent work'
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
