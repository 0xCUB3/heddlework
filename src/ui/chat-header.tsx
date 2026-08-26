import React from 'react'
import { basename } from 'node:path'
import { Select, SelectContent, SelectItem, SelectTrigger, type SelectItemState, type SelectTriggerState } from '@gpuix/react'
import type { WorkbenchController } from '../workbench/controller.ts'
import { contentText, type WorkbenchState } from '../workbench/state.ts'
import { Button, IconButton } from './primitives.tsx'
import { Icon } from './icons.tsx'
import { openPath } from './open-external.ts'
import { colors } from './theme.ts'

export function ChatHeader({
  state,
  controller,
  diffOpen,
  onToggleDiff,
}: {
  state: WorkbenchState
  controller: WorkbenchController
  diffOpen: boolean
  onToggleDiff(): void
}) {
  const projectName = basename(state.workspacePath) || state.workspacePath
  const title = activeThreadTitle(state)
  return (
    <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 20, paddingRight: 12, backgroundColor: colors.background, userSelect: 'none' }}>
      <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Icon name="folder" size={14} color={colors.textFaint} />
        <text style={{ color: colors.textMuted, fontSize: 12, fontWeight: 500, maxWidth: 160, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{projectName}</text>
        <text style={{ color: colors.textFaint, fontSize: 12 }}>/</text>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 600, minWidth: 0, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{title}</text>
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, flexShrink: 0 }}>
        <ActionMenu state={state} controller={controller} compact={diffOpen} />
        {diffOpen ? (
          <>
            <IconButton icon="box" label="Open" onClick={() => openPath(state.workspacePath)} />
            <IconButton icon="download" label="Export" disabled={state.messages.length === 0} onClick={() => void controller.exportSession()} />
          </>
        ) : (
          <>
            <Button label="Open" icon="box" compact onClick={() => openPath(state.workspacePath)} />
            <Button label="Export" compact disabled={state.messages.length === 0} onClick={() => void controller.exportSession()} />
          </>
        )}
        <IconButton icon="panel" label="Toggle Diff panel" testId="toggle-diff" active={diffOpen} onClick={onToggleDiff} />
      </div>
    </div>
  )
}

function ActionMenu({ state, controller, compact }: { state: WorkbenchState; controller: WorkbenchController; compact: boolean }) {
  const options = [
    { value: 'new', label: 'New thread', detail: 'Start a clean Pi session' },
    { value: 'compact', label: 'Compact context', detail: 'Reduce the current context window' },
    { value: 'export', label: 'Export transcript', detail: 'Write this thread as HTML' },
  ]
  return (
    <Select
      value=""
      onValueChange={(value) => {
        if (value === 'new') void controller.newSession()
        if (value === 'compact') void controller.compact()
        if (value === 'export') void controller.exportSession()
      }}
    >
      <SelectTrigger
        testId="add-action"
        style={(trigger: SelectTriggerState) => ({ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, width: compact ? 30 : 'auto', height: 28, paddingLeft: compact ? 0 : 9, paddingRight: compact ? 0 : 9, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: trigger.open ? colors.hover : colors.raised, cursor: 'pointer', hover: { backgroundColor: colors.hover } })}
      >
        <Icon name="plus" size={13} color={colors.text} />
        {!compact && <text style={{ color: colors.text, fontSize: 11, fontWeight: 550 }}>Add action</text>}
      </SelectTrigger>
      <SelectContent side="bottom" sideOffset={7} align="end" style={{ width: 226, padding: 5, borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover }}>
        {options.map((option) => {
          const disabled = state.session.isStreaming || (option.value !== 'new' && state.messages.length === 0)
          return (
            <SelectItem
              key={option.value}
              value={option.value}
              textValue={option.label}
              disabled={disabled}
              style={(item: SelectItemState) => ({ display: 'flex', flexDirection: 'column', gap: 2, paddingTop: 7, paddingBottom: 7, paddingLeft: 9, paddingRight: 9, borderRadius: 7, opacity: disabled ? 0.4 : 1, backgroundColor: item.highlighted ? colors.hover : colors.popover, cursor: disabled ? 'default' : 'pointer' })}
            >
              <text style={{ color: colors.text, fontSize: 11, fontWeight: 600 }}>{option.label}</text>
              <text style={{ color: colors.textFaint, fontSize: 9 }}>{option.detail}</text>
            </SelectItem>
          )
        })}
      </SelectContent>
    </Select>
  )
}

export function activeThreadTitle(state: WorkbenchState): string {
  if (state.session.sessionName) return state.session.sessionName
  const current = state.sessions.find((session) => session.path === state.session.sessionFile)
  if (current) return current.title
  const firstUser = state.messages.find((message) => message.role === 'user')
  const text = firstUser ? contentText(firstUser.content).trim() : ''
  if (!text) return 'New thread'
  return text.length > 68 ? `${text.slice(0, 65)}…` : text
}
