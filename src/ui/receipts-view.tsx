import React, { useState } from 'react'
import type { MutationReceipt } from '../receipts/types.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { WrappedDiff } from './diff-panel.tsx'
import { Button } from './primitives.tsx'
import { RightPanelHeader, rightPanelStyle } from './right-panel-header.tsx'
import { colors, nativeTheme } from './theme.ts'

export function ReceiptsPanel({
  receipts,
  controller,
  fullscreen,
  fullscreenProgress,
  fullscreenLocked = false,
  onClose,
  onNewSurface,
  onToggleFullscreen,
}: {
  receipts: MutationReceipt[]
  controller: WorkbenchController
  fullscreen: boolean
  fullscreenProgress: number
  fullscreenLocked?: boolean
  onClose(): void
  onNewSurface(): void
  onToggleFullscreen(): void
}) {
  const [expanded, setExpanded] = useState<string | undefined>()
  const ordered = [...receipts].reverse()
  const expandedFile = expanded ? findFile(ordered, expanded) : undefined
  return (
    <div testId="receipts-panel" style={rightPanelStyle(fullscreen)}>
      <RightPanelHeader icon="check" title="Receipts" fullscreen={fullscreen} fullscreenProgress={fullscreenProgress} fullscreenLocked={fullscreenLocked} onNew={onNewSurface} onToggleFullscreen={onToggleFullscreen} onClose={onClose} />
      {expandedFile ? (
        <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 34, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, borderWidth: 1, borderColor: colors.border }}>
            <Button label="Back" compact icon="chevronLeft" onClick={() => setExpanded(undefined)} />
            <text style={{ color: colors.text, fontSize: 11, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis', minWidth: 0 }}>{expandedFile.path}</text>
          </div>
          {expandedFile.patch ? <WrappedDiff patch={expandedFile.patch} /> : <text style={{ padding: 12, color: colors.textMuted, fontSize: 11 }}>Patch was too large to store with this receipt.</text>}
        </div>
      ) : (
        <div testId="receipts-scroll" style={{ flexGrow: 1, minHeight: 0, overflow: 'scroll', display: 'flex', flexDirection: 'column', gap: 10, padding: 12 }}>
          {ordered.length === 0 && <text testId="receipts-empty" style={{ color: colors.textMuted, fontSize: 11 }}>No receipts yet. A receipt is written after each turn that changes files.</text>}
          {ordered.map((receipt) => (
            <div key={receipt.id} testId={`receipt:${receipt.id}`} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card }}>
              <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <text style={{ color: colors.text, fontSize: 12, fontWeight: 650 }}>{`Turn ${receipt.turn}`}</text>
                <text style={{ color: colors.textMuted, fontSize: 10 }}>{new Date(receipt.completedAt).toLocaleTimeString()}</text>
                <div style={{ flexGrow: 1 }} />
                <text style={{ color: colors.textMuted, fontSize: 10 }}>{receipt.tools.map((tool) => `${tool.name}×${tool.count}`).join('  ') || 'no tools'}</text>
              </div>
              {receipt.files.map((file) => (
                <div key={file.path} testId={`receipt-file:${file.path}`} tabIndex={0} style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 24, paddingLeft: 6, paddingRight: 6, borderRadius: 6, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={() => setExpanded(`${receipt.id}:${file.path}`)}>
                  <text style={{ width: 62, flexShrink: 0, color: file.status === 'deleted' ? colors.error : file.status === 'added' ? colors.success : colors.textMuted, fontSize: 10, fontWeight: 600 }}>{file.status}</text>
                  <text style={{ minWidth: 0, flexGrow: 1, color: colors.text, fontSize: 11, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{file.path}</text>
                  <text style={{ color: colors.success, fontSize: 10 }}>{`+${file.additions}`}</text>
                  <text style={{ color: colors.error, fontSize: 10 }}>{`-${file.deletions}`}</text>
                </div>
              ))}
            </div>
          ))}
          {ordered.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'flex-end' }}>
              <Button label="Clear receipts" compact icon="eraser" onClick={() => controller.clearReceipts(ordered[0]!.sessionPath)} />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function findFile(receipts: MutationReceipt[], key: string) {
  const separator = key.indexOf(':')
  const id = key.slice(0, separator)
  const path = key.slice(separator + 1)
  return receipts.find((receipt) => receipt.id === id)?.files.find((file) => file.path === path)
}
