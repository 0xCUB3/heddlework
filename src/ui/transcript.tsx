import React, { memo, useEffect, useMemo, useState } from 'react'
import type { WorkbenchState, ToolRun } from '../workbench/state.ts'
import { buildTimeline, type TimelineItem } from '../workbench/timeline.ts'
import { Icon, type IconName } from './icons.tsx'
import { colors, nativeTheme } from './theme.ts'
import { openExternal } from './open-external.ts'
import { resolveToolPresentation, type ToolPresenter } from './tool-presenters.ts'

const MAX_TOOL_OUTPUT = 24_000

type DisplayTimelineItem = Exclude<TimelineItem, { kind: 'tool' }> | {
  id: string
  kind: 'tool-group'
  tools: Array<Extract<TimelineItem, { kind: 'tool' }>>
}

export const Transcript = memo(function Transcript({
  state,
  presenters,
  onOpenDiff,
}: {
  state: WorkbenchState
  presenters: ReadonlyMap<string, ToolPresenter>
  onOpenDiff(): void
}) {
  const items = useMemo(
    () => groupToolItems(buildTimeline(state.messages, state.liveAssistant, state.liveTools)),
    [state.messages, state.liveAssistant, state.liveTools],
  )

  return (
    <virtual-list
      alignment="top"
      followTail
      overdraw={440}
      estimatedItemHeight={108}
      style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
    >
      {items.length === 0 ? (
        <EmptyConversation workspacePath={state.workspacePath} />
      ) : items.map((item) => (
        <TimelineRow key={item.id} item={item} presenters={presenters} onOpenDiff={onOpenDiff} />
      ))}
      {state.session.isStreaming && <WorkingRow activity={state.activity} />}
      <ComposerSpacer />
    </virtual-list>
  )
})

function TimelineRow({ item, presenters, onOpenDiff }: { item: DisplayTimelineItem; presenters: ReadonlyMap<string, ToolPresenter>; onOpenDiff(): void }) {
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
        {item.kind === 'user' && <UserMessage item={item} />}
        {item.kind === 'assistant' && <AssistantMessage item={item} />}
        {item.kind === 'thinking' && <ThinkingMessage item={item} />}
        {item.kind === 'tool-group' && <ToolGroup tools={item.tools} presenters={presenters} onOpenDiff={onOpenDiff} />}
        {item.kind === 'status' && <StatusMessage text={item.text} error={item.tone === 'error'} timestamp={item.timestamp} />}
      </div>
    </div>
  )
}

function UserMessage({ item }: { item: Extract<DisplayTimelineItem, { kind: 'user' }> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: '100%', gap: 5 }}>
      <div
        style={{
          maxWidth: '80%',
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 13,
          paddingRight: 13,
          borderRadius: 16,
          backgroundColor: colors.message,
        }}
      >
        <text style={{ color: colors.text, fontSize: 14, lineHeight: 21, whiteSpace: 'normal' }}>{item.text}</text>
      </div>
      {item.timestamp && <Timestamp value={item.timestamp} />}
    </div>
  )
}

function AssistantMessage({ item }: { item: Extract<DisplayTimelineItem, { kind: 'assistant' }> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 5, paddingLeft: 4, paddingRight: 4 }}>
      <markdown
        source={item.text || '…'}
        theme={nativeTheme}
        style={{ width: '100%', minWidth: 0 }}
        onLinkClick={(event) => openExternal(String(event.value ?? ''))}
      />
      {item.streaming ? (
        <text style={{ color: colors.textFaint, fontSize: 10 }}>streaming</text>
      ) : item.timestamp ? <Timestamp value={item.timestamp} /> : null}
    </div>
  )
}

function ThinkingMessage({ item }: { item: Extract<DisplayTimelineItem, { kind: 'thinking' }> }) {
  const [expanded, setExpanded] = useState(Boolean(item.streaming))
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', paddingLeft: 1 }}>
      <div
        tabIndex={0}
        style={{ minHeight: 26, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 3, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'enter') setExpanded((value) => !value) }}
      >
        <Icon name="eye" size={15} color={colors.textFaint} />
        <text style={{ color: colors.textMuted, fontSize: 12 }}>{item.streaming ? 'Thinking' : 'Reasoning'}</text>
        <div style={{ flexGrow: 1 }} />
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={12} color={colors.textFaint} />
      </div>
      {expanded && (
        <div style={{ marginTop: 4, padding: 10, borderRadius: 8, backgroundColor: colors.card }}>
          <text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'normal' }}>{item.text}</text>
        </div>
      )}
    </div>
  )
}

function ToolGroup({ tools, presenters, onOpenDiff }: { tools: Array<Extract<TimelineItem, { kind: 'tool' }>>; presenters: ReadonlyMap<string, ToolPresenter>; onOpenDiff(): void }) {
  const running = tools.some((item) => item.tool.status !== 'complete')
  const failed = tools.some((item) => item.tool.isError)
  const [expanded, setExpanded] = useState(running || failed)
  useEffect(() => {
    if (!running && !failed) setExpanded(false)
  }, [failed, running])
  const commandCount = tools.filter((item) => item.tool.name === 'bash').length
  const changedPaths = [...new Set(tools.flatMap((item) => changedPath(item.tool) ? [changedPath(item.tool)!] : []))]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 4, paddingLeft: 3, paddingRight: 1 }}>
      <div
        testId="tool-row"
        tabIndex={0}
        style={{ minHeight: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'enter') setExpanded((value) => !value) }}
      >
        <text style={{ color: failed ? colors.error : colors.textMuted, fontSize: 12 }}>{running ? 'Working' : `Worked for ${workDuration(tools)}`}</text>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} color={colors.textFaint} />
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3, paddingBottom: 5 }}>
          <text style={{ color: colors.textFaint, fontSize: 10 }}>{workSummary(commandCount, tools.length - commandCount)}</text>
          {tools.map((item) => <ToolRow key={item.tool.id} tool={item.tool} presenters={presenters} />)}
        </div>
      )}
      {changedPaths.length > 0 && <ChangedFilesCard paths={changedPaths} onOpenDiff={onOpenDiff} />}
    </div>
  )
}

function ToolRow({ tool, presenters }: { tool: ToolRun; presenters: ReadonlyMap<string, ToolPresenter> }) {
  const [expanded, setExpanded] = useState(tool.status !== 'complete' || tool.isError)
  const presentation = resolveToolPresentation(tool, presenters)
  const args = formatArgs(tool.args, tool.argsText)
  const content = presentation.content.length > MAX_TOOL_OUTPUT
    ? `${presentation.content.slice(0, MAX_TOOL_OUTPUT)}\n\n[Display truncated]`
    : presentation.content
  const icon = toolIcon(tool.name)
  const summary = toolSummary(tool)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
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
          hover: { backgroundColor: colors.hover },
        }}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'enter') setExpanded((value) => !value) }}
      >
        <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={tool.isError ? 'x' : icon} size={15} color={tool.isError ? colors.error : colors.textFaint} />
        </div>
        <text style={{ color: colors.textMuted, fontSize: 12, minWidth: 0, flexShrink: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{summary}</text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: tool.isError ? colors.error : tool.status === 'complete' ? colors.textFaint : colors.info, fontSize: 10 }}>
          {tool.isError ? 'failed' : tool.status === 'complete' ? 'done' : tool.status}
        </text>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} color={colors.textFaint} />
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 7, paddingLeft: 31, paddingTop: 4, paddingBottom: 6 }}>
          {args && <code code={args} language="json" showHeader={false} theme={nativeTheme} style={{ width: '100%' }} />}
          {content ? (
            presentation.kind === 'diff'
              ? <diff patch={content} wordDiff maxLines={500} theme={nativeTheme} style={{ width: '100%' }} />
              : (
                <code
                  code={content}
                  showHeader={false}
                  theme={nativeTheme}
                  style={{ width: '100%' }}
                  {...(presentation.language ? { language: presentation.language } : {})}
                  {...(presentation.path ? { path: presentation.path } : {})}
                />
              )
          ) : tool.status === 'complete' ? null : (
            <text style={{ color: colors.textFaint, fontSize: 11 }}>Waiting for output…</text>
          )}
        </div>
      )}
    </div>
  )
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

function ComposerSpacer() {
  return <div style={{ width: '100%', height: 194 }} />
}

function Timestamp({ value }: { value: number }) {
  return <text style={{ color: colors.textFaint, fontSize: 9 }}>{formatTimestamp(value)}</text>
}

function groupToolItems(items: TimelineItem[]): DisplayTimelineItem[] {
  const grouped: DisplayTimelineItem[] = []
  for (const item of items) {
    if (item.kind !== 'tool') {
      grouped.push(item)
      continue
    }
    const previous = grouped.at(-1)
    if (previous?.kind === 'tool-group') previous.tools.push(item)
    else grouped.push({ id: `tool-group-${item.id}`, kind: 'tool-group', tools: [item] })
  }
  return grouped
}

export function ChangedFilesCard({ paths, onOpenDiff }: { paths: string[]; onOpenDiff(): void }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7, marginTop: 5, padding: 10, borderRadius: 10, backgroundColor: colors.card }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <Icon name="chevronDown" size={10} color={colors.textFaint} />
        <text style={{ color: colors.text, fontSize: 10, fontWeight: 600 }}>{`${paths.length} changed ${paths.length === 1 ? 'file' : 'files'}`}</text>
        <div style={{ flexGrow: 1 }} />
        <div testId="changed-files-open-diff" tabIndex={0} style={{ height: 24, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingLeft: 7, paddingRight: 7, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onOpenDiff} onKeyDown={(event) => { if (event.key === 'enter') onOpenDiff() }}>
          <Icon name="fileDiff" size={11} color={colors.textFaint} />
          <text style={{ color: colors.textMuted, fontSize: 9 }}>Open diff</text>
        </div>
      </div>
      {paths.map((path) => (
        <React.Fragment key={path}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 13 }}>
            <Icon name="fileDiff" size={11} color={colors.textFaint} />
            <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{path}</text>
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

function workDuration(tools: Array<Extract<TimelineItem, { kind: 'tool' }>>): string {
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
