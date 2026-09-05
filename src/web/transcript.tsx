import { useState } from 'react'
import type { TranscriptProjectionRow } from '../ui/transcript-projection.ts'
import { MarkdownBody } from './markdown.tsx'
import { projectWorkspaceRows } from './rows.ts'
import type { WorkbenchSnapshot } from '../protocol/index.ts'

export function Transcript({ state }: { state: WorkbenchSnapshot }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const rows = projectWorkspaceRows(state, expanded)
  return (
    <div className="web-transcript">
      {state.messagesHasOlder ? <button type="button" className="web-link" onClick={() => void sendLoadEarlier()}>Load earlier</button> : null}
      {rows.map((row) => <TranscriptRow key={row.id} row={row} expanded={expanded.has(traceIdOf(row))} onToggle={() => toggle(setExpanded, traceIdOf(row))} />)}
    </div>
  )
}

function sendLoadEarlier(): void {
  void import('./store.ts').then(({ workspaceClient }) => workspaceClient().sendAndReport({ type: 'loadEarlierMessages' }))
}

function stepLabel(count: number): string {
  return `${count} ${count === 1 ? 'step' : 'steps'}`
}

function TranscriptRow({ row, expanded, onToggle }: { row: TranscriptProjectionRow; expanded: boolean; onToggle: () => void }) {
  if (row.kind === 'timeline-item') {
    const item = row.item
    if (item.kind === 'user') return <article className="web-bubble web-bubble-user"><MarkdownBody source={item.text} /></article>
    if (item.kind === 'assistant') return <article className="web-bubble web-bubble-assistant"><MarkdownBody source={item.text} /></article>
    if (item.kind === 'status') return <p className="web-meta">{item.text}</p>
    return <p className="web-meta">message</p>
  }
  if (row.kind === 'trace-header') {
    return (
      <button type="button" className="web-trace-header" onClick={onToggle} aria-expanded={expanded}>
        {expanded ? 'Hide work' : 'Show work'} · {stepLabel(row.trace.items.length)}
        {row.trace.changedPaths.length > 0 ? ` · ${row.trace.changedPaths.join(', ')}` : ''}
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
