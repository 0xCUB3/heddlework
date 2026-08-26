import React, { memo, useEffect, useMemo, useState } from 'react'
import type { PiImageContent } from '../pi/types.ts'
import type { WorkbenchState, ToolRun } from '../workbench/state.ts'
import { buildTimeline, type TimelineItem } from '../workbench/timeline.ts'
import { Icon, type IconName } from './icons.tsx'
import { colors, nativeTheme } from './theme.ts'
import { openExternal } from './open-external.ts'
import { copyTextToClipboard } from './clipboard-media.ts'
import { resolveToolPresentation, type FabricAuditPresentation, type FabricToolPresentation, type ToolPresenter } from './tool-presenters.ts'

const MAX_TOOL_OUTPUT = 24_000

type DisplayTimelineItem = Exclude<TimelineItem, { kind: 'tool' }> | {
  id: string
  kind: 'tool-group'
  tools: Array<Extract<TimelineItem, { kind: 'tool' }>>
  revertEntryId?: string
}

export const Transcript = memo(function Transcript({
  state,
  presenters,
  onOpenDiff,
  onRevert,
}: {
  state: WorkbenchState
  presenters: ReadonlyMap<string, ToolPresenter>
  onOpenDiff(): void
  onRevert(entryId: string): void
}) {
  const items = useMemo(
    () => groupToolItems(buildTimeline(state.messages, state.liveAssistant, state.liveTools, state.forkMessages)),
    [state.forkMessages, state.messages, state.liveAssistant, state.liveTools],
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
        <TimelineRow key={item.id} item={item} presenters={presenters} onOpenDiff={onOpenDiff} onRevert={onRevert} />
      ))}
      {state.session.isStreaming && <WorkingRow activity={state.activity} />}
      <ComposerSpacer />
    </virtual-list>
  )
})

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
        {item.kind === 'thinking' && <ThinkingMessage item={item} onRevert={onRevert} />}
        {item.kind === 'tool-group' && <ToolGroup tools={item.tools} presenters={presenters} onOpenDiff={onOpenDiff} onRevert={onRevert} />}
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

function ThinkingMessage({ item, onRevert }: { item: Extract<DisplayTimelineItem, { kind: 'thinking' }>; onRevert(entryId: string): void }) {
  const [expanded, setExpanded] = useState(Boolean(item.streaming))
  const [hovered, setHovered] = useState(false)
  return (
    <div testId="thinking-message" style={{ display: 'flex', flexDirection: 'column', width: '100%', paddingLeft: 1 }} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}>
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
      {!item.streaming && <MessageFooter timestamp={item.timestamp} copyText={item.text} revertEntryId={item.revertEntryId} hovered={hovered} align="start" onRevert={onRevert} />}
    </div>
  )
}

function ToolGroup({ tools, presenters, onOpenDiff, onRevert }: { tools: Array<Extract<TimelineItem, { kind: 'tool' }>>; presenters: ReadonlyMap<string, ToolPresenter>; onOpenDiff(): void; onRevert(entryId: string): void }) {
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
          {tools.map((item) => <ToolRow key={item.tool.id} item={item} presenters={presenters} onRevert={onRevert} />)}
        </div>
      )}
      {changedPaths.length > 0 && <ChangedFilesCard paths={changedPaths} onOpenDiff={onOpenDiff} />}
    </div>
  )
}

function ToolRow({ item, presenters, onRevert }: { item: Extract<TimelineItem, { kind: 'tool' }>; presenters: ReadonlyMap<string, ToolPresenter>; onRevert(entryId: string): void }) {
  const tool = item.tool
  const [hovered, setHovered] = useState(false)
  const [expanded, setExpanded] = useState(tool.status !== 'complete' || tool.isError)
  const presentation = resolveToolPresentation(tool, presenters)
  const args = formatArgs(tool.args, tool.argsText)
  const content = presentation.content.length > MAX_TOOL_OUTPUT
    ? `${presentation.content.slice(0, MAX_TOOL_OUTPUT)}\n\n[Display truncated]`
    : presentation.content
  const icon = toolIcon(tool.name)
  const summary = presentation.title ?? toolSummary(tool)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
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
          hover: { backgroundColor: colors.hover },
        }}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => { if (event.key === 'enter') setExpanded((value) => !value) }}
      >
        <div style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={tool.isError ? 'x' : icon} size={15} color={tool.isError ? colors.error : colors.textFaint} />
        </div>
        <text style={{ color: colors.textMuted, fontSize: 12, minWidth: 0, flexShrink: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', ...(tool.name === 'fabric_exec' ? { fontFamily: nativeTheme.fontMono } : {}) }}>{summary}</text>
        <div style={{ flexGrow: 1 }} />
        {hovered && <InlineAction icon="copy" testId="copy-tool" onClick={() => void copyTextToClipboard(toolCopyText(tool, args, content))} />}
        {hovered && item.revertEntryId && <InlineAction icon="undo" testId="revert-tool" onClick={() => onRevert(item.revertEntryId!)} />}
        <text style={{ color: tool.isError ? colors.error : tool.status === 'complete' ? colors.textFaint : colors.info, fontSize: 10 }}>
          {tool.isError ? 'failed' : tool.status === 'complete' ? 'done' : tool.status}
        </text>
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} color={colors.textFaint} />
      </div>
      {expanded && (presentation.fabric ? (
        <FabricToolBody fabric={presentation.fabric} output={content} />
      ) : (
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
      ))}
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
        {fabric.description && <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17 }}>{fabric.description}</text>}
      </div>
      {fabric.code && <code code={fabric.code} language="typescript" showHeader theme={nativeTheme} style={{ width: '100%' }} />}
      {fabric.audits.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
          {fabric.audits.map((audit, index) => <FabricAuditCard key={`${audit.ref}-${index}`} audit={audit} />)}
        </div>
      )}
      {output && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <text style={{ color: colors.textFaint, fontSize: 10, fontWeight: 600, fontFamily: nativeTheme.fontMono }}>RESULT</text>
          <code code={output} language={fabric.outputLanguage ?? 'text'} showHeader={false} theme={nativeTheme} style={{ width: '100%' }} />
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
      {audit.args && <code code={formatFabricValue(audit.args)} language="json" showHeader={false} theme={nativeTheme} style={{ width: '100%' }} />}
      {result && (
        <code
          code={result}
          showHeader={false}
          theme={nativeTheme}
          style={{ width: '100%' }}
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
  const copy = async () => {
    if (!await copyTextToClipboard(copyText)) return
    setCopied(true)
    setTimeout(() => setCopied(false), 900)
  }
  const actions = hovered ? (
    <>
      {revertEntryId && <InlineAction icon="undo" testId="revert-message" onClick={() => onRevert(revertEntryId)} />}
      {copyText && <InlineAction icon={copied ? 'check' : 'copy'} testId="copy-message" onClick={() => void copy()} />}
    </>
  ) : null
  return (
    <div style={{ minHeight: 22, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: align === 'end' ? 'flex-end' : 'flex-start', gap: 5 }}>
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
    if (previous?.kind === 'tool-group') {
      previous.tools.push(item)
      if (item.revertEntryId) previous.revertEntryId = item.revertEntryId
    } else {
      grouped.push({ id: `tool-group-${item.id}`, kind: 'tool-group', tools: [item], ...(item.revertEntryId ? { revertEntryId: item.revertEntryId } : {}) })
    }
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
