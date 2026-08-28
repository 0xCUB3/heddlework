import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ComposerImage, PiModel, PiSessionStats, SlashCommand, ThinkingLevel } from '../pi/types.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { questionnaireFromTool } from '../workbench/ask-user.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button, ChipSelect, type SelectOption } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import { editorTextAfterImagePaste, readClipboardImage } from './clipboard-media.ts'
import { MotionDiv } from './motion.ts'
import { useResponsiveLayout } from './responsive.tsx'
import { QueueDock } from './queue-dock.tsx'
import { CommandPalette, ExtensionSurfaceRail, QuestionnaireWaitingDock } from './composer-surfaces.tsx'

export { extensionSurfaceRailReserveHeight, questionnaireWaitingDockReserveHeight } from './composer-surfaces.tsx'

export function Composer({ state, controller, draft = false, onPickerOpenChange }: { state: WorkbenchState; controller: WorkbenchController; draft?: boolean; onPickerOpenChange?(open: boolean): void }) {
  const layout = useResponsiveLayout()
  const [pastingImage, setPastingImage] = useState(false)
  const [contextPopoverMounted, setContextPopoverMounted] = useState(false)
  const [contextPopoverOpen, setContextPopoverOpen] = useState(false)
  const contextPopoverExitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const queuedByKeyDown = useRef(false)
  const commandPickedByKeyDown = useRef(false)
  const commandQuery = composerCommandQuery(state.editorText)
  const matchingCommands = useMemo(() => commandQuery === undefined ? [] : matchCommands(state.commands, commandQuery).slice(0, 8), [commandQuery, state.commands])
  const [activeCommandIndex, setActiveCommandIndex] = useState(0)
  const collapsedQuestionnaire = useMemo(() => state.questionnaireCollapsed === undefined
    ? undefined
    : state.liveTools
      .map(questionnaireFromTool)
      .find((questionnaire) => questionnaire?.toolCallId === state.questionnaireCollapsed), [state.liveTools, state.questionnaireCollapsed])
  useEffect(() => setActiveCommandIndex(0), [commandQuery])
  useEffect(() => {
    const request = state.uiRequest
    if (request?.kind === 'model' || request?.kind === 'thinking') controller.completeUiRequest(request.id)
  }, [controller, state.uiRequest])
  useEffect(() => () => {
    if (contextPopoverExitTimer.current) clearTimeout(contextPopoverExitTimer.current)
  }, [])
  const showContextPopover = () => {
    if (contextPopoverExitTimer.current) clearTimeout(contextPopoverExitTimer.current)
    contextPopoverExitTimer.current = undefined
    setContextPopoverMounted(true)
    setContextPopoverOpen(true)
  }
  const hideContextPopover = () => {
    setContextPopoverOpen(false)
    if (contextPopoverExitTimer.current) clearTimeout(contextPopoverExitTimer.current)
    contextPopoverExitTimer.current = setTimeout(() => {
      contextPopoverExitTimer.current = undefined
      setContextPopoverMounted(false)
    }, CONTEXT_POPOVER_MOTION_MS)
  }
  const toggleContextPopover = () => {
    if (contextPopoverOpen) hideContextPopover()
    else showContextPopover()
  }
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

  const send = (value: string, queue = false) => {
    if (!value.trim() && state.editorImages.length === 0) {
      if (!queue && state.queue.paused && state.queue.items.length > 0) controller.resumeQueue()
      return
    }
    void controller.submit(value, { queue })
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

  const chooseCommand = (command: SlashCommand) => controller.setEditorText(`/${command.name} `)
  const handleComposerKeyDown = (event: { key?: string; modifiers?: { alt?: boolean; cmd?: boolean; ctrl?: boolean } }) => {
    const key = event.key?.toLowerCase()
    if (matchingCommands.length > 0 && commandQuery !== undefined) {
      if (key === 'down' || key === 'arrowdown') {
        setActiveCommandIndex((index) => (index + 1) % matchingCommands.length)
        return
      }
      if (key === 'up' || key === 'arrowup') {
        setActiveCommandIndex((index) => (index - 1 + matchingCommands.length) % matchingCommands.length)
        return
      }
      const command = matchingCommands[Math.min(activeCommandIndex, matchingCommands.length - 1)]
      if (command && (key === 'tab' || ((key === 'enter' || key === 'return') && commandQuery !== command.name))) {
        commandPickedByKeyDown.current = true
        chooseCommand(command)
        queueMicrotask(() => { commandPickedByKeyDown.current = false })
        return
      }
    }
    if (key === 'v' && (event.modifiers?.cmd || event.modifiers?.ctrl)) void pasteClipboardImage(state.editorText)
    if (key === 'enter' && event.modifiers?.alt) {
      queuedByKeyDown.current = true
      send(state.editorText, true)
      queueMicrotask(() => { queuedByKeyDown.current = false })
    }
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
        paddingLeft: layout.composerGutter,
        paddingRight: layout.composerGutter,
        paddingBottom: draft ? 0 : 10,
        gap: 0,
        overflow: 'visible',
      }}
    >
      {collapsedQuestionnaire && <QuestionnaireWaitingDock questionnaire={collapsedQuestionnaire} controller={controller} />}
      {matchingCommands.length > 0 && <CommandPalette commands={matchingCommands} activeIndex={Math.min(activeCommandIndex, matchingCommands.length - 1)} onChoose={chooseCommand} />}
      <ExtensionSurfaceRail above={above} below={below} statuses={state.statusItems} />
      <QueueDock state={state} controller={controller} />

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
          placeholder={connected ? (draft ? (layout.mobile ? 'Ask anything, @tag files, or / for commands' : 'Ask anything, @tag files/folders, $use skills, or / for commands') : 'Ask for follow-up changes or attach images') : 'Reconnect to Pi to begin'}
          minRows={3}
          maxRows={7}
          autoFocus
          readOnly={!connected}
          theme={nativeTheme}
          style={{
            width: '100%',
            minWidth: 0,
            paddingLeft: layout.mobile ? 13 : 16,
            paddingRight: layout.mobile ? 13 : 16,
            color: colors.text,
            fontSize: 14,
            lineHeight: 21,
            borderWidth: 0,
            backgroundColor: colors.transparent,
          }}
          onChange={(event) => controller.setEditorText(String(event.value ?? ''))}
          onKeyDown={handleComposerKeyDown}
          onSubmit={(event) => {
            if (commandPickedByKeyDown.current) {
              commandPickedByKeyDown.current = false
              return
            }
            if (queuedByKeyDown.current) {
              queuedByKeyDown.current = false
              return
            }
            send(String(event.value ?? state.editorText), Boolean(event.modifiers?.alt))
          }}
        />

        <div testId="composer-toolbar" style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: layout.mobile ? 2 : 4, marginTop: 10, paddingLeft: layout.mobile ? 8 : 10, paddingRight: layout.mobile ? 8 : 11, overflow: 'visible', userSelect: 'none' }}>
          <ChipSelect
            testId="model-picker"
            icon="sparkles"
            value={currentModel}
            options={modelOptions}
            width={layout.mobile ? layout.popoverWidth : 320}
            triggerMaxWidth={layout.mobile ? 106 : 320}
            searchable
            {...(state.uiRequest?.kind === 'model' ? { openRequest: state.uiRequest.id } : {})}
            {...(onPickerOpenChange ? { onOpenChange: onPickerOpenChange } : {})}
            onChange={(value) => {
              const model = state.models.find((candidate) => modelKey(candidate) === value)
              if (model) void controller.setModel(model)
            }}
          />
          {!layout.mobile && <ToolbarSeparator />}
          <ChipSelect
            testId="thinking-picker"
            value={state.session.thinkingLevel}
            options={thinkingOptions}
            width={layout.mobile ? Math.min(180, layout.popoverWidth) : 130}
            triggerMaxWidth={layout.mobile ? 68 : 130}
            {...(state.uiRequest?.kind === 'thinking' ? { openRequest: state.uiRequest.id } : {})}
            {...(onPickerOpenChange ? { onOpenChange: onPickerOpenChange } : {})}
            onChange={(value) => void controller.setThinkingLevel(value as ThinkingLevel)}
          />
          <div style={{ flexGrow: 1 }} />
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: layout.mobile ? 4 : 9 }}>
            {typeof contextPercent === 'number' && state.stats && <ContextMeter stats={state.stats} compact={layout.mobile} popoverOpen={contextPopoverOpen} onToggle={toggleContextPopover} onMouseEnter={showContextPopover} onMouseLeave={hideContextPopover} />}
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
      {contextPopoverMounted && state.stats && (
        <div testId="context-popover-positioner" style={{ position: 'absolute', right: layout.mobile ? 0 : 46, bottom: 84, width: layout.mobile ? layout.popoverWidth : 256, display: 'flex', backgroundColor: colors.transparent }}>
          <ContextPopover stats={state.stats} open={contextPopoverOpen} width={layout.mobile ? layout.popoverWidth : 256} />
        </div>
      )}
      </div>

    </div>
  )
}

function ToolbarSeparator() {
  return <div style={{ width: 1, height: 16, backgroundColor: colors.borderStrong, marginLeft: 1, marginRight: 1 }} />
}

const CONTEXT_POPOVER_MOTION_MS = 160

function ContextMeter({ stats, compact, popoverOpen, onToggle, onMouseEnter, onMouseLeave }: { stats: PiSessionStats; compact: boolean; popoverOpen: boolean; onToggle(): void; onMouseEnter(): void; onMouseLeave(): void }) {
  const percent = Math.max(0, Math.min(100, stats.contextUsage?.percent ?? 0))
  const rounded = Math.round(percent * 10) / 10
  const tone = percent > 80 ? colors.warning : percent > 60 ? '#D8A95B' : colors.textMuted
  return (
    <div testId="context-meter" tabIndex={0} style={{ position: 'relative', height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', ...(compact ? { width: 30, justifyContent: 'center' } : {}), gap: compact ? 0 : 7, paddingLeft: compact ? 0 : 9, paddingRight: compact ? 0 : 8, borderRadius: 9, marginRight: compact ? 0 : 9, backgroundColor: popoverOpen ? colors.hover : colors.transparent, cursor: 'pointer' }} onClick={onToggle} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
      {!compact && <text style={{ color: popoverOpen ? colors.text : colors.textMuted, fontSize: 11, fontFamily: nativeTheme.fontMono }}>{`${rounded}%`}</text>}
      <div style={{ width: compact ? 16 : 18, height: compact ? 16 : 18, borderRadius: 9, borderWidth: 2, borderColor: tone }} />
    </div>
  )
}

function ContextPopover({ stats, open, width }: { stats: PiSessionStats; open: boolean; width: number }) {
  const percent = Math.max(0, Math.min(100, stats.contextUsage?.percent ?? 0))
  const rounded = Math.round(percent * 10) / 10
  const tokens = stats.contextUsage?.tokens ?? 0
  const contextWindow = stats.contextUsage?.contextWindow ?? 0
  return (
    <MotionDiv
      testId="context-popover"
      initial={{ opacity: 0, top: 4 }}
      animate={{ opacity: open ? 1 : 0, top: open ? 0 : 4 }}
      transition={{ duration: CONTEXT_POPOVER_MOTION_MS / 1_000, ease: 'easeOut' }}
      style={{ position: 'relative', width, display: 'flex', flexDirection: 'column', borderRadius: 12, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'hidden' }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center' }}>
          <text style={{ color: colors.text, fontSize: 13, fontFamily: nativeTheme.fontMono }}>{`${rounded}%`}</text>
          <div style={{ flexGrow: 1 }} />
          <text style={{ color: colors.textMuted, fontSize: 11, fontFamily: nativeTheme.fontMono }}>{`${formatTokenCount(tokens)} / ${formatTokenCount(contextWindow)}`}</text>
        </div>
        <div style={{ position: 'relative', width: '100%', height: 8, borderRadius: 4, backgroundColor: colors.hover, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 226 * percent / 100, backgroundColor: percent > 80 ? colors.warning : colors.primary }} />
        </div>
      </div>
      <div style={{ height: 1, backgroundColor: colors.borderStrong }} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 14 }}>
        <ContextStat label="Messages" value={String(stats.totalMessages ?? 0)} />
        <ContextStat label="Tool calls" value={String(stats.toolCalls ?? 0)} />
      </div>
      <div style={{ height: 1, backgroundColor: colors.borderStrong }} />
      <div style={{ display: 'flex', flexDirection: 'row', padding: 14, backgroundColor: colors.card }}>
        <text style={{ color: colors.textMuted, fontSize: 11 }}>Total cost</text>
        <div style={{ flexGrow: 1 }} />
        <text style={{ color: colors.text, fontSize: 12, fontFamily: nativeTheme.fontMono }}>{`$${(stats.cost ?? 0).toFixed(2)}`}</text>
      </div>
    </MotionDiv>
  )
}

function ContextStat({ label, value }: { label: string; value: string }) {
  return <div style={{ display: 'flex', flexDirection: 'row' }}><text style={{ color: colors.textMuted, fontSize: 11 }}>{label}</text><div style={{ flexGrow: 1 }} /><text style={{ color: colors.text, fontSize: 11, fontFamily: nativeTheme.fontMono }}>{value}</text></div>
}

function formatTokenCount(value: number): string {
  if (value >= 1_000_000) return `${Math.round(value / 100_000) / 10}M`
  if (value >= 1_000) return `${Math.round(value / 100) / 10}K`
  return String(value)
}

function ComposerContextShadow() {
  const alphas = nativeTheme.appearance === 'light'
    ? ['12', '10', '0E', '0C', '0A', '08', '06', '04', '02', '01']
    : ['28', '24', '20', '1C', '18', '14', '10', '0C', '08', '04']
  return (
    <div testId="composer-context-shadow" style={{ position: 'absolute', left: 0, right: 0, top: 12, height: 10, display: 'flex', flexDirection: 'column', pointerEvents: 'none' }}>
      {alphas.map((alpha, index) => (
        <React.Fragment key={alpha}>
          <div {...(index === 0 ? { testId: 'composer-context-shadow-strong' } : {})} style={{ height: 1, backgroundColor: `#000000${alpha}` }} />
        </React.Fragment>
      ))}
    </div>
  )
}

function ComposerContextBar({ branch }: { branch: string }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div testId="composer-context-bar" style={{ position: 'absolute', left: 22, right: 22, bottom: 0, height: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 20, paddingBottom: 4, paddingLeft: 13, paddingRight: 13, userSelect: 'none' }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, borderWidth: 1, borderColor: colors.composerOutline, borderRadius: 16, backgroundColor: colors.contextBar }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 16, backgroundColor: colors.contextBar }} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: 1, height: 16, backgroundColor: colors.composerOutline }} />
      <div style={{ position: 'absolute', right: 0, top: 0, width: 1, height: 16, backgroundColor: colors.composerOutline }} />
      <ComposerContextShadow />
      <Icon name="folder" size={13} color={colors.contextIcon} />
      {!mobile && <text testId="composer-checkout-label" style={{ color: colors.contextText, fontSize: 12 }}>Local checkout</text>}
      <div style={{ flexGrow: 1 }} />
      <Icon name="gitBranch" size={12} color={colors.contextIcon} />
      <text testId="composer-branch-label" style={{ minWidth: 0, color: colors.contextText, fontSize: 12, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{branch}</text>
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

function composerCommandQuery(value: string): string | undefined {
  const match = /^\/([^\s]*)$/.exec(value)
  return match?.[1]?.toLowerCase()
}

function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  const normalized = query.toLowerCase()
  return commands
    .map((command, index) => {
      const name = command.name.toLowerCase()
      const description = command.description?.toLowerCase() ?? ''
      const score = name === normalized ? 0 : name.startsWith(normalized) ? 1 : name.includes(normalized) ? 2 : description.includes(normalized) ? 3 : 4
      return { command, index, score }
    })
    .filter(({ score }) => normalized.length === 0 || score < 4)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map(({ command }) => command)
}

function modelKey(model: PiModel): string {
  return `${model.provider}/${model.id}`
}

function thinkingLabel(level: ThinkingLevel): string {
  if (level === 'off') return 'Off'
  if (level === 'xhigh') return 'Extra high'
  return `${level.charAt(0).toUpperCase()}${level.slice(1)}`
}
