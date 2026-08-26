import React, { useEffect, useSyncExternalStore } from 'react'
import { useGpuixRequired } from '@gpuix/react'
import { basename } from 'node:path'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Button, Label } from './primitives.tsx'
import { Composer } from './composer.tsx'
import { Transcript } from './transcript.tsx'
import type { ToolPresenter } from './tool-presenters.ts'
import { colors } from './theme.ts'

export function WorkbenchApp({
  controller,
  presenters,
}: {
  controller: WorkbenchController
  presenters: ReadonlyMap<string, ToolPresenter>
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
  const renderer = useGpuixRequired()

  useEffect(() => {
    renderer.setWindowTitle?.(state.windowTitle)
  }, [renderer, state.windowTitle])

  return (
    <div style={{ display: 'flex', flexDirection: 'row', width: '100%', height: '100%', backgroundColor: colors.window, color: colors.text }}>
      <Sidebar state={state} controller={controller} />
      <div style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, height: '100%' }}>
        <Header state={state} controller={controller} />
        <Transcript state={state} presenters={presenters} onQuickPrompt={(prompt) => controller.setEditorText(prompt)} />
        <Composer state={state} controller={controller} />
      </div>
    </div>
  )
}

function Sidebar({ state, controller }: { state: WorkbenchState; controller: WorkbenchController }) {
  const workspaceName = basename(state.workspacePath) || state.workspacePath
  const sessionName = state.session.sessionName || 'Current session'
  const sessionFile = state.session.sessionFile ? basename(state.session.sessionFile) : state.session.sessionId?.slice(0, 10)
  const statusEntries = Object.entries(state.statusItems)
  const connectionColor = state.connection === 'connected'
    ? colors.success
    : state.connection === 'connecting'
      ? colors.warning
      : colors.error

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 244,
        flexShrink: 0,
        height: '100%',
        paddingLeft: 12,
        paddingRight: 12,
        paddingBottom: 12,
        borderWidth: 1,
        borderColor: '#202329',
        backgroundColor: colors.sidebar,
        userSelect: 'none',
      }}
    >
      <div style={{ height: 44, flexShrink: 0 }} />
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9, height: 38 }}>
        <div style={{ width: 25, height: 25, borderRadius: 8, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentMuted }}>
          <text style={{ color: colors.accent, fontSize: 16, fontWeight: 700 }}>π</text>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Pi Workbench</text>
          <text style={{ color: colors.textFaint, fontSize: 9 }}>GPUIX native client</text>
        </div>
      </div>

      <div style={{ marginTop: 10 }}>
        <SidebarAction
          label="＋  New task"
          testId="new-session"
          disabled={state.session.isStreaming || state.connection !== 'connected'}
          onClick={() => void controller.newSession()}
        />
      </div>

      <div style={{ marginTop: 20, marginBottom: 7, paddingLeft: 5 }}><Label>Workspace</Label></div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: 10,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.sidebarRaised,
        }}
      >
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{workspaceName}</text>
        <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{state.workspacePath}</text>
      </div>

      <div style={{ marginTop: 18, marginBottom: 7, paddingLeft: 5 }}><Label>Session</Label></div>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 5,
          padding: 10,
          borderRadius: 8,
          backgroundColor: colors.sidebarRaised,
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: state.session.isStreaming ? colors.accent : colors.textFaint }} />
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 550, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{sessionName}</text>
        </div>
        {sessionFile && <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{sessionFile}</text>}
        <SessionMetrics state={state} />
      </div>

      {statusEntries.length > 0 && (
        <>
          <div style={{ marginTop: 18, marginBottom: 7, paddingLeft: 5 }}><Label>Extensions</Label></div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {statusEntries.map(([key, text]) => (
              <ExtensionStatus key={key} text={text} />
            ))}
          </div>
        </>
      )}

      <div style={{ flexGrow: 1 }} />
      {state.connection === 'error' && (
        <div style={{ marginBottom: 8 }}>
          <Button label="Reconnect" onClick={() => void controller.reconnect()} />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 26, paddingLeft: 4 }}>
        <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: connectionColor }} />
        <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <text style={{ color: colors.textMuted, fontSize: 10 }}>{state.connection}</text>
          <text style={{ color: colors.textFaint, fontSize: 8, lineClamp: 1 }}>{state.connectionMessage}</text>
        </div>
      </div>
    </div>
  )
}

function ExtensionStatus({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 7, paddingLeft: 5 }}>
      <text style={{ color: colors.blue, fontSize: 9 }}>●</text>
      <text style={{ color: colors.textMuted, fontSize: 10, lineHeight: 14 }}>{text}</text>
    </div>
  )
}

function Header({ state, controller }: { state: WorkbenchState; controller: WorkbenchController }) {
  const model = state.session.model
  const contextPercent = state.stats?.contextUsage?.percent
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        height: 48,
        flexShrink: 0,
        paddingLeft: 16,
        paddingRight: 14,
        borderWidth: 1,
        borderColor: '#1C1F24',
        userSelect: 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {state.session.sessionName || basename(state.workspacePath) || 'Pi Workbench'}
        </text>
        <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>
          {model ? `${model.provider}/${model.id}` : 'No model selected'}
        </text>
      </div>
      <div style={{ flexGrow: 1 }} />
      {typeof contextPercent === 'number' && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: 110, gap: 3, marginRight: 10 }}>
          <text style={{ color: colors.textFaint, fontSize: 9, whiteSpace: 'nowrap' }}>{`${contextPercent.toFixed(1)}% context`}</text>
          <div style={{ width: 110, height: 3, borderRadius: 2, backgroundColor: colors.raised }}>
            <div style={{ width: `${Math.max(0, Math.min(100, contextPercent))}%`, height: 3, borderRadius: 2, backgroundColor: contextPercent > 80 ? colors.warning : colors.accent }} />
          </div>
        </div>
      )}
      <Button
        label="Compact"
        tone="quiet"
        compact
        disabled={state.connection !== 'connected' || state.session.isStreaming}
        onClick={() => void controller.compact()}
      />
    </div>
  )
}

function SessionMetrics({ state }: { state: WorkbenchState }) {
  const stats = state.stats
  if (!stats) return null
  const messages = stats.totalMessages ?? state.messages.length
  const tools = stats.toolCalls ?? 0
  const cost = typeof stats.cost === 'number' && stats.cost > 0 ? `$${stats.cost.toFixed(3)}` : undefined
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 9, marginTop: 3 }}>
      <text style={{ color: colors.textFaint, fontSize: 9 }}>{`${messages} messages`}</text>
      <text style={{ color: colors.textFaint, fontSize: 9 }}>{`${tools} tools`}</text>
      {cost && <text style={{ color: colors.textFaint, fontSize: 9 }}>{cost}</text>}
    </div>
  )
}

function SidebarAction({
  label,
  onClick,
  disabled,
  testId,
}: {
  label: string
  onClick(): void
  disabled: boolean
  testId?: string
}) {
  return (
    <div
      {...(testId ? { testId } : {})}
      tabIndex={disabled ? -1 : 0}
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        minHeight: 34,
        paddingLeft: 10,
        paddingRight: 10,
        borderRadius: 7,
        backgroundColor: colors.sidebarRaised,
        opacity: disabled ? 0.45 : 1,
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: colors.hover } }),
      }}
      {...(disabled ? {} : {
        onClick,
        onKeyDown: (event: { key?: string }) => {
          if (event.key === 'enter') onClick()
        },
      })}
    >
      <text style={{ color: colors.text, fontSize: 11, fontWeight: 550 }}>{label}</text>
    </div>
  )
}
