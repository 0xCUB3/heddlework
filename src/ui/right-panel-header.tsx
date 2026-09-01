import React from 'react'
import { Icon, type IconName } from './icons.tsx'
import { IconButton } from './primitives.tsx'
import { colors } from './theme.ts'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'

export function RightPanelHeader({
  icon,
  title,
  fullscreen,
  fullscreenProgress,
  fullscreenLocked = false,
  refreshDisabled = false,
  onNew,
  onRefresh,
  onToggleFullscreen,
  onClose,
}: {
  icon: IconName
  title: string
  fullscreen: boolean
  fullscreenProgress?: number | undefined
  fullscreenLocked?: boolean
  refreshDisabled?: boolean
  onNew?(): void
  onRefresh?(): void
  onToggleFullscreen(): void
  onClose(): void
}) {
  const titlebarProgress = fullscreenProgress ?? (fullscreen ? 1 : 0)
  const trafficLightInset = process.platform === 'darwin' ? 96 * titlebarProgress : 0
  return (
    <MotionDiv initial={false} animate={{ paddingLeft: 9 + trafficLightInset }} transition={LAYOUT_MOTION_TRANSITION} testId="right-panel-header" style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 9 + trafficLightInset, paddingRight: 9 }}>
      <div testId="right-panel-tab" style={{ height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 9, borderRadius: 8, backgroundColor: colors.raised }}>
        <Icon name={icon} size={13} color={colors.textMuted} />
        <text style={{ color: colors.text, fontSize: 11, fontWeight: 600 }}>{title}</text>
      </div>
      {onNew && <IconButton icon="plus" label="Open a new surface" testId="right-panel-new-tab" onClick={onNew} />}
      <div style={{ flexGrow: 1 }} />
      <div testId="right-panel-actions" style={{ height: 30, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 2 }}>
        {onRefresh && <IconButton icon="refresh" label={`Refresh ${title}`} testId="right-panel-refresh" disabled={refreshDisabled} onClick={onRefresh} />}
        {!fullscreenLocked && <IconButton icon={fullscreen ? 'minimize' : 'maximize'} label={fullscreen ? `Restore ${title} panel` : `Fullscreen ${title} panel`} testId={fullscreen ? 'right-panel-restore' : 'right-panel-fullscreen'} onClick={onToggleFullscreen} />}
        <IconButton icon="x" label={`Close ${title} panel`} testId={title === 'Diff' ? 'close-diff' : 'close-surface'} onClick={onClose} />
      </div>
    </MotionDiv>
  )
}

export function rightPanelStyle(fullscreen: boolean, panelWidth?: number) {
  return {
    width: fullscreen ? '100%' : panelWidth ?? '44%',
    minWidth: fullscreen || panelWidth !== undefined ? 0 : 420,
    height: '100%',
    flexShrink: 0,
    display: 'flex',
    flexDirection: 'column',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.panel,
  }
}
