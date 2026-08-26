import React, { memo, useMemo, useState } from 'react'
import type { WorkbenchState, ToolRun } from '../workbench/state.ts'
import { buildTimeline, type TimelineItem } from '../workbench/timeline.ts'
import { colors, nativeTheme } from './theme.ts'
import { openExternal } from './open-external.ts'
import { resolveToolPresentation, type ToolPresenter } from './tool-presenters.ts'

const MAX_TOOL_OUTPUT = 24_000

export const Transcript = memo(function Transcript({
  state,
  presenters,
  onQuickPrompt,
}: {
  state: WorkbenchState
  presenters: ReadonlyMap<string, ToolPresenter>
  onQuickPrompt(prompt: string): void
}) {
  const items = useMemo(
    () => buildTimeline(state.messages, state.liveAssistant, state.liveTools),
    [state.messages, state.liveAssistant, state.liveTools],
  )

  return (
    <virtual-list
      alignment="bottom"
      followTail
      overdraw={400}
      estimatedItemHeight={150}
      style={{ flexGrow: 1, minHeight: 0, width: '100%' }}
    >
      {items.length === 0 ? (
        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', width: '100%', padding: 28 }}>
          <EmptyState workspacePath={state.workspacePath} onQuickPrompt={onQuickPrompt} />
        </div>
      ) : items.map((item) => (
        <TimelineRow key={item.id} item={item} presenters={presenters} />
      ))}
    </virtual-list>
  )
})

function TimelineRow({ item, presenters }: { item: TimelineItem; presenters: ReadonlyMap<string, ToolPresenter> }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'center',
        width: '100%',
        paddingTop: 8,
        paddingBottom: 8,
        paddingLeft: 24,
        paddingRight: 24,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 860, minWidth: 0 }}>
        {item.kind === 'user' && <UserMessage text={item.text} />}
        {item.kind === 'assistant' && <AssistantMessage text={item.text} streaming={item.streaming ?? false} />}
        {item.kind === 'thinking' && <ThinkingMessage text={item.text} streaming={item.streaming ?? false} />}
        {item.kind === 'tool' && <ToolCard tool={item.tool} presenters={presenters} />}
        {item.kind === 'status' && <StatusMessage text={item.text} error={item.tone === 'error'} />}
      </div>
    </div>
  )
}

function UserMessage({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end', width: '100%' }}>
      <div
        style={{
          maxWidth: 680,
          paddingTop: 10,
          paddingBottom: 10,
          paddingLeft: 14,
          paddingRight: 14,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.user,
        }}
      >
        <text style={{ color: colors.text, fontSize: 14, lineHeight: 21, whiteSpace: 'normal' }}>{text}</text>
      </div>
    </div>
  )
}

function AssistantMessage({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 6 }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, userSelect: 'none' }}>
        <div style={{ width: 18, height: 18, borderRadius: 5, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentMuted }}>
          <text style={{ color: colors.accent, fontSize: 12, fontWeight: 700 }}>π</text>
        </div>
        <text style={{ color: colors.textMuted, fontSize: 11, fontWeight: 600 }}>PI</text>
        {streaming && <text style={{ color: colors.accent, fontSize: 10 }}>● streaming</text>}
      </div>
      <markdown
        source={text || '…'}
        theme={nativeTheme}
        style={{ width: '100%', minWidth: 0 }}
        onLinkClick={(event) => openExternal(String(event.value ?? ''))}
      />
    </div>
  )
}

function ThinkingMessage({ text, streaming }: { text: string; streaming: boolean }) {
  const [expanded, setExpanded] = useState(streaming)
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        borderWidth: 1,
        borderColor: colors.borderStrong,
        paddingLeft: 11,
        gap: 7,
      }}
    >
      <div
        tabIndex={0}
        style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'enter') setExpanded((value) => !value)
        }}
      >
        <text style={{ color: colors.textFaint, fontSize: 11 }}>{expanded ? '▾' : '▸'}</text>
        <text style={{ color: colors.textMuted, fontSize: 11, fontWeight: 600 }}>Reasoning</text>
        {streaming && <text style={{ color: colors.textFaint, fontSize: 10 }}>live</text>}
      </div>
      {expanded && <text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 19, whiteSpace: 'normal' }}>{text}</text>}
    </div>
  )
}

function ToolCard({ tool, presenters }: { tool: ToolRun; presenters: ReadonlyMap<string, ToolPresenter> }) {
  const [expanded, setExpanded] = useState(tool.status !== 'complete' || tool.isError)
  const presentation = resolveToolPresentation(tool, presenters)
  const args = formatArgs(tool.args, tool.argsText)
  const rawContent = presentation.content
  const truncated = rawContent.length > MAX_TOOL_OUTPUT
  const content = truncated ? `${rawContent.slice(0, MAX_TOOL_OUTPUT)}\n\n[Workbench truncated this display]` : rawContent
  const statusColor = tool.isError ? colors.error : tool.status === 'complete' ? colors.success : colors.warning
  const statusLabel = tool.isError ? 'failed' : tool.status === 'complete' ? 'done' : tool.status

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        minWidth: 0,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: tool.isError ? '#583038' : colors.border,
        backgroundColor: colors.panel,
        overflow: 'visible',
      }}
    >
      <div
        tabIndex={0}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          minHeight: 34,
          paddingLeft: 10,
          paddingRight: 10,
          cursor: 'pointer',
          userSelect: 'none',
          hover: { backgroundColor: colors.hover },
        }}
        onClick={() => setExpanded((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'enter') setExpanded((value) => !value)
        }}
      >
        <text style={{ color: colors.textFaint, fontSize: 10 }}>{expanded ? '▾' : '▸'}</text>
        <text style={{ color: colors.blue, fontSize: 11, fontWeight: 700 }}>{tool.name}</text>
        {presentation.title && (
          <text style={{ color: colors.textMuted, fontSize: 11, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0, flexShrink: 1 }}>
            {presentation.title}
          </text>
        )}
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: statusColor, fontSize: 10, fontWeight: 600 }}>{statusLabel}</text>
      </div>
      {expanded && (
        <div style={{ display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0, gap: 8, padding: 9, paddingTop: 2 }}>
          {args && (
            <code code={args} language="json" showHeader={false} theme={nativeTheme} style={{ width: '100%' }} />
          )}
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
          ) : (
            <text style={{ color: colors.textFaint, fontSize: 11 }}>{tool.status === 'complete' ? 'No output' : 'Waiting for output…'}</text>
          )}
        </div>
      )}
    </div>
  )
}

function StatusMessage({ text, error }: { text: string; error: boolean }) {
  return (
    <div style={{ padding: 8, borderWidth: 1, borderColor: error ? colors.error : colors.border, borderRadius: 7 }}>
      <text style={{ color: error ? colors.error : colors.textMuted, fontSize: 12, lineHeight: 18 }}>{text}</text>
    </div>
  )
}

function EmptyState({ workspacePath, onQuickPrompt }: { workspacePath: string; onQuickPrompt(prompt: string): void }) {
  const workspace = workspacePath.split(/[\\/]/).filter(Boolean).at(-1) ?? workspacePath
  const prompts = [
    'Give me a concise overview of this repository.',
    'Find the highest-risk unfinished work in this repository.',
    'Run the most relevant tests and explain any failures.',
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%', maxWidth: 620, paddingTop: 70, gap: 16 }}>
      <div style={{ width: 46, height: 46, borderRadius: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentMuted }}>
        <text style={{ color: colors.accent, fontSize: 25, fontWeight: 700 }}>π</text>
      </div>
      <text style={{ color: colors.text, fontSize: 20, fontWeight: 650 }}>{`Work in ${workspace}`}</text>
      <text style={{ color: colors.textMuted, fontSize: 13, lineHeight: 20, textAlign: 'center' }}>
        Pi can inspect files, run commands, edit code, and keep the session here.
      </text>
      <div style={{ display: 'flex', flexDirection: 'column', width: '100%', gap: 7, marginTop: 8 }}>
        {prompts.map((prompt) => (
          <QuickPrompt key={prompt} prompt={prompt} onPick={onQuickPrompt} />
        ))}
      </div>
    </div>
  )
}

function QuickPrompt({ prompt, onPick }: { prompt: string; onPick(prompt: string): void }) {
  return (
    <div
      tabIndex={0}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 38,
        paddingLeft: 12,
        paddingRight: 12,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.panel,
        cursor: 'pointer',
        userSelect: 'none',
        hover: { backgroundColor: colors.hover },
      }}
      onClick={() => onPick(prompt)}
      onKeyDown={(event) => {
        if (event.key === 'enter') onPick(prompt)
      }}
    >
      <text style={{ color: colors.textMuted, fontSize: 12 }}>{prompt}</text>
      <div style={{ flexGrow: 1 }} />
      <text style={{ color: colors.textFaint, fontSize: 12 }}>↗</text>
    </div>
  )
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
