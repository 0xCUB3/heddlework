import React, { useState } from 'react'
import type { PiModel, ThinkingLevel } from '../pi/types.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { ExtensionDialog, ExtensionWidget, Notice, WorkbenchState } from '../workbench/state.ts'
import { Button, ChipSelect, type SelectOption } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export function Composer({ state, controller }: { state: WorkbenchState; controller: WorkbenchController }) {
  const connected = state.connection === 'connected'
  const modelOptions: SelectOption[] = state.models.map((model) => ({
    value: modelKey(model),
    label: model.name ?? model.id,
    detail: `${model.provider}/${model.id}`,
  }))
  const thinkingOptions: SelectOption[] = state.thinkingLevels.map((level) => ({ value: level, label: thinkingLabel(level) }))
  const currentModel = state.session.model ? modelKey(state.session.model) : ''
  const above = Object.values(state.widgets).filter((widget) => widget.placement === 'aboveEditor')
  const below = Object.values(state.widgets).filter((widget) => widget.placement === 'belowEditor')

  const send = (value: string) => {
    if (!value.trim()) return
    void controller.submit(value)
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        flexShrink: 0,
        width: '100%',
        paddingLeft: 24,
        paddingRight: 24,
        paddingBottom: 12,
        overflow: 'visible',
        gap: 7,
      }}
    >
      {state.notices.map((notice) => (
        <NoticeBar key={notice.id} notice={notice} onDismiss={() => controller.dismissNotice(notice.id)} />
      ))}
      {state.dialog && <ExtensionDialogPanel key={state.dialog.id} dialog={state.dialog} controller={controller} />}
      {above.map((widget) => <ExtensionWidgetPanel key={widget.key} widget={widget} />)}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          width: '100%',
          maxWidth: 900,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: state.session.isStreaming ? '#40552B' : colors.borderStrong,
          backgroundColor: colors.panel,
          paddingTop: 10,
          paddingBottom: 9,
          overflow: 'visible',
        }}
      >
        <textarea
          testId="composer"
          value={state.editorText}
          placeholder={connected ? (state.session.isStreaming ? 'Steer the running agent…' : 'Ask Pi to work on this repository…') : 'Reconnect to Pi to begin'}
          minRows={1}
          maxRows={6}
          autoFocus
          readOnly={!connected}
          theme={nativeTheme}
          style={{
            width: '100%',
            minWidth: 0,
            paddingLeft: 12,
            paddingRight: 12,
            color: colors.text,
            fontSize: 14,
            lineHeight: 21,
            borderWidth: 0,
            backgroundColor: colors.transparent,
          }}
          onChange={(event) => controller.setEditorText(String(event.value ?? ''))}
          onSubmit={(event) => send(String(event.value ?? state.editorText))}
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
            marginTop: 8,
            paddingLeft: 10,
            paddingRight: 10,
            overflow: 'visible',
            userSelect: 'none',
          }}
        >
          <ChipSelect
            testId="model-picker"
            label="MODEL"
            value={currentModel}
            options={modelOptions}
            width={260}
            onChange={(value) => {
              const model = state.models.find((candidate) => modelKey(candidate) === value)
              if (model) void controller.setModel(model)
            }}
          />
          <ChipSelect
            testId="thinking-picker"
            label="THINK"
            value={state.session.thinkingLevel}
            options={thinkingOptions}
            width={150}
            onChange={(value) => void controller.setThinkingLevel(value as ThinkingLevel)}
          />
          <div style={{ flexGrow: 1 }} />
          {state.queue.steering.length + state.queue.followUp.length > 0 && (
            <text style={{ color: colors.textFaint, fontSize: 10 }}>
              {state.queue.steering.length + state.queue.followUp.length} queued
            </text>
          )}
          {state.session.isStreaming && (
            <Button label="Stop" tone="danger" compact testId="abort" onClick={() => void controller.abort()} />
          )}
          <Button
            label={state.session.isStreaming ? 'Steer ↗' : 'Send ↑'}
            tone="primary"
            compact
            testId="send"
            disabled={!connected || !state.editorText.trim()}
            onClick={() => send(state.editorText)}
          />
        </div>
      </div>
      {below.map((widget) => <ExtensionWidgetPanel key={widget.key} widget={widget} />)}
      <div style={{ display: 'flex', flexDirection: 'row', width: '100%', maxWidth: 900, alignItems: 'center', minHeight: 14, userSelect: 'none' }}>
        <text style={{ color: colors.textFaint, fontSize: 9 }}>Enter to send · Shift+Enter for newline</text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: state.session.isStreaming ? colors.accent : colors.textFaint, fontSize: 9 }}>{state.activity}</text>
      </div>
    </div>
  )
}

function NoticeBar({ notice, onDismiss }: { notice: Notice; onDismiss(): void }) {
  const color = notice.kind === 'error' ? colors.error : notice.kind === 'warning' ? colors.warning : colors.blue
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        width: '100%',
        maxWidth: 900,
        minHeight: 30,
        paddingLeft: 10,
        paddingRight: 7,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: color,
        backgroundColor: colors.panel,
        gap: 8,
      }}
    >
      <text style={{ color, fontSize: 10 }}>●</text>
      <text style={{ color: colors.textMuted, fontSize: 11, minWidth: 0, flexShrink: 1 }}>{notice.message}</text>
      <div style={{ flexGrow: 1 }} />
      <div tabIndex={0} style={{ padding: 4, cursor: 'pointer', userSelect: 'none' }} onClick={onDismiss}>
        <text style={{ color: colors.textFaint, fontSize: 11 }}>×</text>
      </div>
    </div>
  )
}

function ExtensionWidgetPanel({ widget }: { widget: ExtensionWidget }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: 900,
        gap: 3,
        padding: 9,
        borderRadius: 7,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.panel,
      }}
    >
      {widget.lines.map((line, index) => (
        <WidgetLine key={`${widget.key}-${index}`} line={line} />
      ))}
    </div>
  )
}

function WidgetLine({ line }: { line: string }) {
  return <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 16 }}>{line}</text>
}

function ExtensionDialogPanel({ dialog, controller }: { dialog: ExtensionDialog; controller: WorkbenchController }) {
  const [value, setValue] = useState(dialog.prefill ?? '')
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: '100%',
        maxWidth: 900,
        gap: 9,
        padding: 12,
        borderRadius: 9,
        borderWidth: 1,
        borderColor: colors.warning,
        backgroundColor: '#24231E',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={{ color: colors.warning, fontSize: 11, fontWeight: 700 }}>PI EXTENSION</text>
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 600 }}>{dialog.title}</text>
        <div style={{ flexGrow: 1 }} />
        {dialog.timeout && <text style={{ color: colors.textFaint, fontSize: 10 }}>timed request</text>}
      </div>
      {dialog.message && <text style={{ color: colors.textMuted, fontSize: 12, lineHeight: 18 }}>{dialog.message}</text>}
      {dialog.method === 'select' && (
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(dialog.options ?? []).map((option) => (
            <Button key={option} label={option} onClick={() => controller.respondToDialog({ value: option })} />
          ))}
          <Button label="Cancel" tone="quiet" onClick={() => controller.respondToDialog({ cancelled: true })} />
        </div>
      )}
      {dialog.method === 'confirm' && (
        <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}>
          <Button label="Confirm" tone="primary" onClick={() => controller.respondToDialog({ confirmed: true })} />
          <Button label="Decline" onClick={() => controller.respondToDialog({ confirmed: false })} />
        </div>
      )}
      {(dialog.method === 'input' || dialog.method === 'editor') && (
        <>
          <textarea
            value={value}
            placeholder={dialog.placeholder ?? ''}
            minRows={dialog.method === 'editor' ? 4 : 1}
            maxRows={dialog.method === 'editor' ? 10 : 3}
            autoFocus
            theme={nativeTheme}
            style={{
              width: '100%',
              minWidth: 0,
              padding: 9,
              borderRadius: 7,
              borderWidth: 1,
              borderColor: colors.borderStrong,
              backgroundColor: colors.raised,
              color: colors.text,
              fontSize: 12,
              lineHeight: 18,
            }}
            onChange={(event) => setValue(String(event.value ?? ''))}
            onSubmit={() => controller.respondToDialog({ value })}
          />
          <div style={{ display: 'flex', flexDirection: 'row', gap: 6 }}>
            <Button label="Submit" tone="primary" onClick={() => controller.respondToDialog({ value })} />
            <Button label="Cancel" tone="quiet" onClick={() => controller.respondToDialog({ cancelled: true })} />
          </div>
        </>
      )}
    </div>
  )
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`
}

function thinkingLabel(level: ThinkingLevel): string {
  if (level === 'off') return 'Off'
  if (level === 'xhigh') return 'Extra high'
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}
