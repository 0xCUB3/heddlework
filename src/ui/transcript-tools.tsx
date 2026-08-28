import React, { useRef } from 'react'
import type { StyleDesc } from '@gpuix/react'
import type { TimelineItem } from '../workbench/timeline.ts'
import type { ToolRun } from '../workbench/state.ts'
import { copyTextToClipboard } from './clipboard-media.ts'
import { Icon, type IconName } from './icons.tsx'
import { TranscriptInlineAction } from './transcript-actions.tsx'
import { colors, nativeTheme } from './theme.ts'
import {
  resolveToolPresentation,
  type FabricAuditPresentation,
  type FabricToolPresentation,
  type ToolPresenter,
} from './tool-presenters.ts'

const MAX_TOOL_OUTPUT = 24_000
const FABRIC_COLLAPSED_CALL_LIMIT = 8

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

export function ToolRow({ item, presenters, expanded, onToggle, onRevert }: { item: Extract<TimelineItem, { kind: 'tool' }>; presenters: ReadonlyMap<string, ToolPresenter>; expanded: boolean; onToggle(): void; onRevert(entryId: string): void }) {
  const tool = item.tool
  const presentation = resolveToolPresentation(tool, presenters)
  const suppressToggle = useRef(false)
  const runTranscriptInlineAction = (action: () => void) => {
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
        <TranscriptInlineAction icon="copy" testId="copy-tool" onClick={() => runTranscriptInlineAction(() => { void copyTextToClipboard(toolCopyText(tool, args, content)) })} />
        {item.revertEntryId && <TranscriptInlineAction icon="undo" testId="revert-tool" onClick={() => runTranscriptInlineAction(() => onRevert(item.revertEntryId!))} />}
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

function toolCopyText(tool: ToolRun, args: string, content: string): string {
  return [tool.name, args, content].filter(Boolean).join('\n\n')
}

export function toolIcon(name: string): IconName {
  if (name === 'bash') return 'terminal'
  if (name === 'read') return 'eye'
  if (name === 'edit' || name === 'write') return 'squarePen'
  if (name === 'grep' || name === 'find') return 'search'
  if (name === 'fabric_exec') return 'sparkles'
  return 'wrench'
}

export function toolSummary(tool: ToolRun): string {
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
