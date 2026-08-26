import React, { useState } from 'react'
import type { PiModel, ThinkingLevel } from '../pi/types.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { ExtensionDialog, ExtensionWidget, WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button, ChipSelect, type SelectOption } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export function Composer({ state, controller, draft = false }: { state: WorkbenchState; controller: WorkbenchController; draft?: boolean }) {
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
  const contextPercent = state.stats?.contextUsage?.percent

  const send = (value: string) => {
    if (!value.trim()) return
    void controller.submit(value)
  }

  return (
    <div
      style={{
        position: draft ? 'relative' : 'absolute',
        ...(draft ? {} : { left: 0, right: 0, bottom: 0 }),
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        width: '100%',
        paddingLeft: 20,
        paddingRight: 20,
        paddingBottom: draft ? 0 : 10,
        gap: 0,
        overflow: 'visible',
      }}
    >
      {state.dialog && <ExtensionDialogPanel key={state.dialog.id} dialog={state.dialog} controller={controller} />}
      {above.map((widget) => <ExtensionWidgetPanel key={widget.key} widget={widget} />)}

      <div style={{ position: 'relative', width: '100%', maxWidth: 768, paddingBottom: 25, overflow: 'visible' }}>
        <ComposerContextBar branch={state.workspaceDiff.branch || 'workspace'} />
        <div
          testId="composer-surface"
          style={{
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            borderRadius: 22,
            borderWidth: 1,
            borderColor: state.session.isStreaming ? '#343D60' : colors.composerOutline,
            backgroundColor: colors.composer,
            paddingTop: 14,
            paddingBottom: 12,
            overflow: 'visible',
          }}
        >
        <textarea
          testId="composer"
          value={state.editorText}
          placeholder={connected ? 'Ask anything, @tag files/folders, $use skills, or / for commands' : 'Reconnect to Pi to begin'}
          minRows={3}
          maxRows={7}
          autoFocus
          readOnly={!connected}
          theme={nativeTheme}
          style={{
            width: '100%',
            minWidth: 0,
            paddingLeft: 16,
            paddingRight: 16,
            color: colors.text,
            fontSize: 14,
            lineHeight: 21,
            borderWidth: 0,
            backgroundColor: colors.transparent,
          }}
          onChange={(event) => controller.setEditorText(String(event.value ?? ''))}
          onSubmit={(event) => send(String(event.value ?? state.editorText))}
        />

        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, paddingLeft: 10, paddingRight: 11, overflow: 'visible', userSelect: 'none' }}>
          <ChipSelect
            testId="model-picker"
            icon="sparkles"
            value={currentModel}
            options={modelOptions}
            width={245}
            onChange={(value) => {
              const model = state.models.find((candidate) => modelKey(candidate) === value)
              if (model) void controller.setModel(model)
            }}
          />
          <ToolbarSeparator />
          <ChipSelect
            testId="thinking-picker"
            value={state.session.thinkingLevel}
            options={thinkingOptions}
            width={130}
            onChange={(value) => void controller.setThinkingLevel(value as ThinkingLevel)}
          />
          <div style={{ flexGrow: 1 }} />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 9 }}>
            {state.queue.steering.length + state.queue.followUp.length > 0 && (
              <text style={{ color: colors.textFaint, fontSize: 9 }}>{`${state.queue.steering.length + state.queue.followUp.length} queued`}</text>
            )}
            {typeof contextPercent === 'number' && <ContextMeter percent={contextPercent} />}
            <PrimaryAction
              running={state.session.isStreaming}
              disabled={!connected || (!state.session.isStreaming && !state.editorText.trim())}
              onSend={() => send(state.editorText)}
              onStop={() => void controller.abort()}
            />
          </div>
        </div>
      </div>
      </div>

      {below.map((widget) => <ExtensionWidgetPanel key={widget.key} widget={widget} />)}
    </div>
  )
}

function ToolbarSeparator() {
  return <div style={{ width: 1, height: 16, backgroundColor: colors.borderStrong, marginLeft: 1, marginRight: 1 }} />
}

function ContextMeter({ percent }: { percent: number }) {
  const rounded = Math.max(0, Math.min(100, Math.round(percent)))
  return <div testId="context-meter" style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: rounded > 80 ? colors.warning : colors.borderStrong }} />
}

function ComposerContextBar({ branch }: { branch: string }) {
  return (
    <div testId="composer-context-bar" style={{ position: 'absolute', left: 11, right: 11, bottom: 0, height: 32, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 5, paddingTop: 7, paddingLeft: 12, paddingRight: 12, borderWidth: 1, borderColor: colors.composerOutline, borderRadius: 12, backgroundColor: colors.composer, userSelect: 'none' }}>
      <Icon name="folder" size={12} color={colors.textFaint} />
      <text style={{ color: colors.textFaint, fontSize: 9 }}>Local checkout</text>
      <div style={{ flexGrow: 1 }} />
      <Icon name="gitBranch" size={11} color={colors.textFaint} />
      <text style={{ color: colors.textFaint, fontSize: 9 }}>{branch}</text>
    </div>
  )
}

function PrimaryAction({ running, disabled, onSend, onStop }: { running: boolean; disabled: boolean; onSend(): void; onStop(): void }) {
  const action = running ? onStop : onSend
  const background = running ? '#D72C58' : colors.primary
  return (
    <div
      testId={running ? 'abort' : 'send'}
      tabIndex={disabled ? -1 : 0}
      style={{
        width: 34,
        height: 34,
        borderRadius: 17,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: background,
        opacity: disabled ? 0.32 : 1,
        ...(disabled ? {} : { cursor: 'pointer', hover: { backgroundColor: running ? '#EB3567' : colors.primaryHover } }),
      }}
      {...(disabled ? {} : { onClick: action, onKeyDown: (event: { key?: string }) => { if (event.key === 'enter') action() } })}
    >
      <Icon name={running ? 'stop' : 'arrowUp'} size={17} color="#FFFFFF" />
    </div>
  )
}

function ExtensionWidgetPanel({ widget }: { widget: ExtensionWidget }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, gap: 3, padding: 9, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card }}>
      {widget.lines.map((line, index) => <WidgetLine key={`${widget.key}-${index}`} line={line} />)}
    </div>
  )
}

function WidgetLine({ line }: { line: string }) {
  return <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 16 }}>{line}</text>
}

function ExtensionDialogPanel({ dialog, controller }: { dialog: ExtensionDialog; controller: WorkbenchController }) {
  const [value, setValue] = useState(dialog.prefill ?? '')
  return (
    <div style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, gap: 9, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.warning, backgroundColor: '#211D14' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <text style={{ color: colors.warning, fontSize: 10, fontWeight: 700 }}>PI EXTENSION</text>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 600 }}>{dialog.title}</text>
      </div>
      {dialog.message && <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17 }}>{dialog.message}</text>}
      {dialog.method === 'select' && (
        <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
          {(dialog.options ?? []).map((option) => <Button key={option} label={option} onClick={() => controller.respondToDialog({ value: option })} />)}
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
            style={{ width: '100%', minWidth: 0, padding: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, color: colors.text, fontSize: 12, lineHeight: 18 }}
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
