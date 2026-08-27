import React, { useState } from 'react'
import type { ComposerImage, PiModel, ThinkingLevel } from '../pi/types.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { ExtensionDialog, ExtensionWidget, WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button, ChipSelect, type SelectOption } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import { editorTextAfterImagePaste, readClipboardImage } from './clipboard-media.ts'
import { ComposerNotificationStack } from './notifications.tsx'

export function Composer({ state, controller, draft = false }: { state: WorkbenchState; controller: WorkbenchController; draft?: boolean }) {
  const [pastingImage, setPastingImage] = useState(false)
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
    if (!value.trim() && state.editorImages.length === 0) return
    void controller.submit(value)
  }

  const pasteClipboardImage = async (editorTextBeforePaste: string) => {
    if (pastingImage) return
    setPastingImage(true)
    try {
      const image = await readClipboardImage()
      if (!image) return
      controller.addEditorImage(image)
      const currentText = controller.getSnapshot().editorText
      const restoredText = editorTextAfterImagePaste(editorTextBeforePaste, currentText)
      if (restoredText !== currentText) controller.setEditorText(restoredText)
    } finally {
      setPastingImage(false)
    }
  }

  const handleComposerKeyDown = (event: { key?: string; modifiers?: { cmd?: boolean; ctrl?: boolean } }) => {
    if (event.key?.toLowerCase() === 'v' && (event.modifiers?.cmd || event.modifiers?.ctrl)) void pasteClipboardImage(state.editorText)
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
      <ComposerNotificationStack notices={state.notices} onDismiss={(id) => controller.dismissNotice(id)} onClear={() => controller.clearNotices()} />
      {state.dialog && <ExtensionDialogPanel key={state.dialog.id} dialog={state.dialog} controller={controller} />}
      {above.map((widget) => <ExtensionWidgetPanel key={widget.key} widget={widget} />)}

      <div style={{ position: 'relative', width: '100%', maxWidth: 768, paddingBottom: 32, overflow: 'visible' }}>
        <ComposerContextBar branch={state.workspaceDiff.branch || 'workspace'} />
        <div
          testId="composer-surface"
          style={{
            position: 'relative',
            display: 'flex',
            flexDirection: 'column',
            width: '100%',
            borderRadius: 22,
            borderWidth: 1,
            borderColor: state.session.isStreaming ? '#343D60' : colors.composerFrame,
            backgroundColor: colors.composer,
            paddingTop: 14,
            paddingBottom: 12,
            overflow: 'visible',
          }}
        >
        <div style={{ position: 'absolute', left: 1, right: 1, top: 1, bottom: 1, borderWidth: 1, borderColor: colors.composerHighlight, borderRadius: 21, pointerEvents: 'none' }} />
        {state.editorImages.length > 0 && <ComposerImages images={state.editorImages} onRemove={(id) => controller.removeEditorImage(id)} />}
        {pastingImage && <text style={{ color: colors.textFaint, fontSize: 10, paddingLeft: 16, paddingBottom: 6 }}>Reading image from clipboard…</text>}
        <textarea
          testId="composer"
          value={state.editorText}
          placeholder={connected ? (draft ? 'Ask anything, @tag files/folders, $use skills, or / for commands' : 'Ask for follow-up changes or attach images') : 'Reconnect to Pi to begin'}
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
          onKeyDown={handleComposerKeyDown}
          onSubmit={(event) => send(String(event.value ?? state.editorText))}
        />

        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, paddingLeft: 10, paddingRight: 11, overflow: 'visible', userSelect: 'none' }}>
          <ChipSelect
            testId="model-picker"
            icon="sparkles"
            value={currentModel}
            options={modelOptions}
            width={320}
            searchable
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
              disabled={!connected || (!state.session.isStreaming && !state.editorText.trim() && state.editorImages.length === 0)}
              onSend={() => send(state.editorText)}
              onStop={() => void controller.abort()}
            />
          </div>
        </div>
        <div testId="composer-seam-mask" style={{ position: 'absolute', left: 22, right: 22, bottom: 0, height: 2, backgroundColor: colors.composer, pointerEvents: 'none' }} />
      </div>
      <ComposerContextShadow />
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

function ComposerContextShadow() {
  return (
    <div testId="composer-context-shadow" style={{ position: 'absolute', left: 14, right: 14, bottom: 26, height: 10, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      <div style={{ height: 1, backgroundColor: '#00000028' }} />
      <div style={{ height: 1, backgroundColor: '#00000024' }} />
      <div style={{ height: 1, backgroundColor: '#00000020' }} />
      <div style={{ height: 1, backgroundColor: '#0000001C' }} />
      <div style={{ height: 1, backgroundColor: '#00000018' }} />
      <div style={{ height: 1, backgroundColor: '#00000014' }} />
      <div style={{ height: 1, backgroundColor: '#00000010' }} />
      <div style={{ height: 1, backgroundColor: '#0000000C' }} />
      <div style={{ height: 1, backgroundColor: '#00000008' }} />
      <div style={{ height: 1, backgroundColor: '#00000004' }} />
    </div>
  )
}

function ComposerContextBar({ branch }: { branch: string }) {
  return (
    <div testId="composer-context-bar" style={{ position: 'absolute', left: 22, right: 22, bottom: 0, height: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 20, paddingBottom: 4, paddingLeft: 13, paddingRight: 13, userSelect: 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 1, borderColor: colors.composerOutline, borderRadius: 16, backgroundColor: colors.contextBar }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 16, backgroundColor: colors.contextBar }} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 16, backgroundColor: colors.composerOutline }} />
      <div style={{ position: 'absolute', right: 0, top: 0, width: 1, height: 16, backgroundColor: colors.composerOutline }} />
      <Icon name="folder" size={13} color={colors.contextIcon} />
      <text testId="composer-checkout-label" style={{ color: colors.contextText, fontSize: 12 }}>Local checkout</text>
      <div style={{ flexGrow: 1 }} />
      <Icon name="gitBranch" size={12} color={colors.contextIcon} />
      <text testId="composer-branch-label" style={{ color: colors.contextText, fontSize: 12 }}>{branch}</text>
    </div>
  )
}

function ComposerImages({ images, onRemove }: { images: ComposerImage[]; onRemove(id: string): void }) {
  return (
    <div testId="composer-images" style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8, minHeight: 64, paddingLeft: 16, paddingRight: 16, paddingBottom: 8 }}>
      {images.map((image) => (
        <React.Fragment key={image.id}>
        <div testId="composer-image-preview" style={{ position: 'relative', width: 64, height: 64, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.background, overflow: 'hidden', flexShrink: 0 }}>
          {React.createElement('img', { src: image.previewPath, alt: image.fileName, objectFit: 'cover', style: { width: 64, height: 64 } } as never)}
          <div testId={`remove-composer-image-${image.id}`} tabIndex={0} style={{ position: 'absolute', top: 4, right: 4, width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 6, backgroundColor: '#090A0ADD', cursor: 'pointer', hover: { backgroundColor: '#181919EE' } }} onClick={() => onRemove(image.id)}>
            <Icon name="x" size={12} color={colors.textMuted} />
          </div>
        </div>
        </React.Fragment>
      ))}
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
    <div testId="extension-dialog" style={{ display: 'flex', flexDirection: 'column', width: '100%', maxWidth: 768, minWidth: 0, gap: 9, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.warning, backgroundColor: '#211D14', overflow: 'hidden' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', minWidth: 0, gap: 8 }}>
        <text style={{ color: colors.warning, fontSize: 10, fontWeight: 700, flexShrink: 0 }}>PI EXTENSION</text>
        <text testId="extension-dialog-title" style={{ color: colors.text, fontSize: 12, fontWeight: 600, lineHeight: 17, minWidth: 0, flexGrow: 1, whiteSpace: 'normal' }}>{dialog.title}</text>
      </div>
      {dialog.message && <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17, minWidth: 0, width: '100%', whiteSpace: 'normal' }}>{dialog.message}</text>}
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
