import { useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptProjectionRow } from '../ui/transcript-projection.ts'
import { transcriptProjectionRowsEqual, workTraceLabel } from '../ui/transcript-projection.ts'
import { reuseRowsById, WEB_TRANSCRIPT_ROW_ESTIMATE_PX, webTranscriptWindow } from '../ui/virtual-window.ts'
import { MarkdownBody } from './markdown.tsx'
import { projectWorkspaceRows } from './rows.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'

export function Transcript({ state }: { state: WorkbenchSnapshot }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [followTail, setFollowTail] = useState(true)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportHeight, setViewportHeight] = useState(640)
  const scroller = useRef<HTMLDivElement>(null)
  const previousRows = useRef<TranscriptProjectionRow[]>([])
  const sessionKey = state.session.sessionFile ?? state.session.sessionId ?? state.workspacePath
  const sessionRef = useRef(sessionKey)
  if (sessionRef.current !== sessionKey) {
    sessionRef.current = sessionKey
    previousRows.current = []
  }
  const projected = useMemo(() => projectWorkspaceRows(state, expanded), [expanded, state])
  const rows = useMemo(() => {
    const next = reuseRowsById(previousRows.current, projected, transcriptProjectionRowsEqual)
    previousRows.current = next
    return next
  }, [projected])
  const live = Boolean(state.session.isStreaming)
  const windowed = webTranscriptWindow(rows.length, scrollTop, viewportHeight, followTail)
  const visibleRows = rows.slice(windowed.start, windowed.end)

  useEffect(() => {
    setFollowTail(true)
    setExpanded(new Set())
  }, [sessionKey])

  useEffect(() => {
    if (!followTail) return
    const node = scroller.current
    if (node) node.scrollTop = node.scrollHeight
  }, [followTail, rows, sessionKey])

  return (
    <div
      ref={scroller}
      className="web-transcript"
      data-testid="transcript-list"
      data-window-start={windowed.start}
      data-window-end={windowed.end}
      onScroll={(event) => {
        const node = event.currentTarget
        const remaining = node.scrollHeight - node.scrollTop - node.clientHeight
        const next = remaining < 80
        setScrollTop(node.scrollTop)
        setViewportHeight(node.clientHeight)
        setFollowTail((current) => current === next ? current : next)
      }}
    >
      {state.messagesHasOlder ? <button type="button" className="web-link" onClick={() => void sendLoadEarlier()}>Load earlier</button> : null}
      {windowed.start > 0 ? <div aria-hidden className="web-transcript-spacer" data-testid="transcript-window-before" style={{ height: windowed.start * WEB_TRANSCRIPT_ROW_ESTIMATE_PX }} /> : null}
      {visibleRows.map((row) => (
        <div key={row.id} className="web-transcript-row">
          <TranscriptRow row={row} expanded={expanded.has(traceIdOf(row))} live={live && row.kind === 'trace-header' && isLiveHeader(row, state)} onToggle={() => toggle(setExpanded, traceIdOf(row))} />
        </div>
      ))}
      {windowed.end < rows.length ? <div aria-hidden className="web-transcript-spacer" data-testid="transcript-window-after" style={{ height: (rows.length - windowed.end) * WEB_TRANSCRIPT_ROW_ESTIMATE_PX }} /> : null}
      {!followTail ? (
        <button type="button" className="web-jump-latest" onClick={() => { setFollowTail(true); const node = scroller.current; if (node) node.scrollTop = node.scrollHeight }}>
          Jump to latest
        </button>
      ) : null}
    </div>
  )
}

function sendLoadEarlier(): void {
  void import('./store.ts').then(({ workspaceClient }) => workspaceClient().sendAndReport({ type: 'loadEarlierMessages' }))
}

function isLiveHeader(row: TranscriptProjectionRow, state: WorkbenchSnapshot): boolean {
  if (row.kind !== 'trace-header') return false
  return row.trace.items.some((item) => item.kind === 'thinking' ? Boolean(item.streaming) : item.kind === 'tool' ? item.tool.status !== 'complete' : false)
    || (Boolean(state.session.isStreaming) && row.trace.items.length === 0)
}

function TranscriptRow({ row, expanded, live, onToggle }: { row: TranscriptProjectionRow; expanded: boolean; live: boolean; onToggle: () => void }) {
  if (row.kind === 'timeline-item') {
    const item = row.item
    if (item.kind === 'user') return <article className="web-bubble web-bubble-user"><MarkdownBody source={item.text} /></article>
    if (item.kind === 'assistant') {
      if (item.streaming) return <article className="web-bubble web-bubble-assistant"><pre className="web-stream">{item.text || '…'}</pre></article>
      return <article className="web-bubble web-bubble-assistant"><MarkdownBody source={item.text} /></article>
    }
    if (item.kind === 'status') return <p className="web-meta">{item.text}</p>
    return <p className="web-meta">message</p>
  }
  if (row.kind === 'trace-header') {
    return (
      <button type="button" className="web-trace-header" onClick={onToggle} aria-expanded={expanded} data-testid="execution-trace-label">
        {workTraceLabel(row.trace, live, true)}
        {row.trace.changedPaths.length > 0 ? ` · ${row.trace.changedPaths.length} changed` : ''}
      </button>
    )
  }
  if (row.kind === 'trace-entry') {
    if (!expanded) return null
    const item = row.item
    if (item.kind === 'thinking') return <details className="web-tool"><summary>Thinking</summary><MarkdownBody source={item.text} /></details>
    if (item.kind === 'tool') {
      return (
        <details className="web-tool">
          <summary>{item.tool.name} · {item.tool.status}{item.tool.isError ? ' · error' : ''}</summary>
          {item.tool.output ? <pre>{item.tool.output}</pre> : <p className="web-meta">{JSON.stringify(item.tool.args ?? {}, null, 2)}</p>}
        </details>
      )
    }
    if (item.kind === 'assistant') return <article className="web-bubble web-bubble-assistant"><MarkdownBody source={item.text} /></article>
    return <p className="web-meta">{item.kind}</p>
  }
  if (row.kind === 'trace-files' && expanded) return <p className="web-meta">{row.paths.join(', ')}</p>
  if (row.kind === 'trace-notices' && expanded) return <p className="web-meta">{row.notices.map((notice) => notice.notice.message).join(' · ')}</p>
  if (row.kind === 'trace-continuation' && expanded) return <p className="web-meta">{row.remaining} more</p>
  return null
}

function traceIdOf(row: TranscriptProjectionRow): string {
  if (row.kind === 'trace-header') return row.trace.id
  if (row.kind === 'trace-entry' || row.kind === 'trace-files' || row.kind === 'trace-notices' || row.kind === 'trace-continuation') return row.traceId
  return row.id
}

function toggle(setExpanded: (update: (current: Set<string>) => Set<string>) => void, id: string): void {
  setExpanded((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
}
