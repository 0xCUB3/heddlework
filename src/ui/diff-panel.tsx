import React from 'react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkspaceDiff } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { IconButton } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export function DiffPanel({ diff, controller, onClose }: { diff: WorkspaceDiff; controller: WorkbenchController; onClose(): void }) {
  const patch = diff.files.map((file) => file.patch).join('\n')
  return (
    <div testId="diff-panel" style={{ width: '44%', minWidth: 420, height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9 }}>
        <div style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 9, borderRadius: 8, backgroundColor: colors.raised }}>
          <Icon name="fileDiff" size={13} color={colors.textMuted} />
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 600 }}>Diff</text>
        </div>
        <Icon name="plus" size={13} color={colors.textFaint} />
        <div style={{ flexGrow: 1 }} />
        <IconButton icon="refresh" label="Refresh diff" disabled={diff.status === 'loading'} onClick={() => void controller.refreshWorkspaceDiff()} />
        <IconButton icon="x" label="Close Diff panel" testId="close-diff" onClick={onClose} />
      </div>
      <div style={{ height: 42, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10 }}>
        <div style={{ height: 27, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 8, borderRadius: 8, backgroundColor: colors.raised }}>
          <text style={{ color: colors.text, fontSize: 10, fontWeight: 550 }}>Working tree</text>
          <Icon name="chevronDown" size={10} color={colors.textFaint} />
        </div>
        <div style={{ flexGrow: 1 }} />
        {diff.files.length > 0 && (
          <>
            <text style={{ color: colors.success, fontSize: 10 }}>{`+${diff.additions}`}</text>
            <text style={{ color: colors.error, fontSize: 10 }}>{`−${diff.deletions}`}</text>
          </>
        )}
        <Icon name="list" size={14} color={colors.textFaint} />
      </div>
      {diff.status === 'loading' ? (
        <PanelMessage icon="refresh" title="Loading working tree diff…" />
      ) : diff.status === 'error' ? (
        <PanelMessage icon="fileDiff" title="Diff unavailable" detail={cleanError(diff.error ?? '')} />
      ) : diff.files.length === 0 ? (
        <PanelMessage icon="check" title="No net changes in this selection." />
      ) : (
        <diff patch={patch} wordDiff scroll maxLines={2_000} theme={nativeTheme} style={{ flexGrow: 1, minHeight: 0, width: '100%' }} />
      )}
    </div>
  )
}

function PanelMessage({ icon, title, detail }: { icon: 'refresh' | 'fileDiff' | 'check'; title: string; detail?: string }) {
  return (
    <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, paddingLeft: 30, paddingRight: 30 }}>
      <Icon name={icon} size={18} color={colors.textFaint} />
      <text style={{ color: colors.textFaint, fontSize: 11, textAlign: 'center' }}>{title}</text>
      {detail && <text style={{ color: colors.textFaint, fontSize: 9, lineHeight: 14, textAlign: 'center', lineClamp: 3 }}>{detail}</text>}
    </div>
  )
}

function cleanError(error: string): string {
  const firstLine = error.split('\n').find(Boolean) ?? error
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
}
