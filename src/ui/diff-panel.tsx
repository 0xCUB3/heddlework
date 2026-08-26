import React, { useEffect, useState } from 'react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkspaceDiff, WorkspaceDiffFile } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { IconButton, NativeVirtualList } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export function DiffPanel({
  diff,
  controller,
  onClose,
  onNewSurface,
}: {
  diff: WorkspaceDiff
  controller: WorkbenchController
  onClose(): void
  onNewSurface(): void
}) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  useEffect(() => {
    if (selectedPath && !diff.files.some((file) => file.path === selectedPath)) setSelectedPath(undefined)
  }, [diff.files, selectedPath])
  const selectedFile = selectedPath ? diff.files.find((file) => file.path === selectedPath) : undefined
  const patch = selectedFile?.patch ?? diff.files.map((file) => file.patch).join('\n')
  const additions = selectedFile?.additions ?? diff.additions
  const deletions = selectedFile?.deletions ?? diff.deletions

  return (
    <div testId="diff-panel" style={{ width: '44%', minWidth: 420, height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9 }}>
        <div style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 9, borderRadius: 8, backgroundColor: colors.raised }}>
          <Icon name="fileDiff" size={13} color={colors.textMuted} />
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 600, fontFamily: nativeTheme.fontMono }}>Diff</text>
        </div>
        <IconButton icon="plus" label="Open a new surface" testId="right-panel-new-tab" onClick={onNewSurface} />
        <div style={{ flexGrow: 1 }} />
        <IconButton icon="refresh" label="Refresh diff" disabled={diff.status === 'loading'} onClick={() => void controller.refreshWorkspaceDiff()} />
        <IconButton icon="x" label="Close Diff panel" testId="close-diff" onClick={onClose} />
      </div>
      <div style={{ height: 42, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 10, paddingRight: 10 }}>
        <div style={{ height: 27, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 8, borderRadius: 8, backgroundColor: colors.raised }}>
          <text style={{ color: colors.text, fontSize: 10, fontWeight: 550, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{selectedFile?.path ?? 'Working tree'}</text>
          <Icon name="chevronDown" size={10} color={colors.textFaint} />
        </div>
        <div style={{ flexGrow: 1 }} />
        {diff.files.length > 0 && (
          <>
            <text style={{ color: colors.success, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`+${additions}`}</text>
            <text style={{ color: colors.error, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`−${deletions}`}</text>
          </>
        )}
        <IconButton icon="list" label="Toggle changed files" testId="diff-file-list" active={filesOpen} onClick={() => setFilesOpen((value) => !value)} />
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minHeight: 0 }}>
        {filesOpen && <DiffFileList files={diff.files} selectedPath={selectedPath} onSelect={setSelectedPath} />}
        <div testId="diff-content" style={{ display: 'flex', flexDirection: 'column', flexGrow: 1, minWidth: 0, minHeight: 0, fontFamily: nativeTheme.fontMono }}>
          {diff.status === 'loading' ? (
            <PanelMessage icon="refresh" title="Loading working tree diff…" />
          ) : diff.status === 'error' ? (
            <PanelMessage icon="fileDiff" title="Diff unavailable" detail={cleanError(diff.error ?? '')} />
          ) : diff.files.length === 0 ? (
            <PanelMessage icon="check" title="No net changes in this selection." />
          ) : (
            <diff patch={patch} wordDiff scroll maxLines={2_000} theme={nativeTheme} style={{ flexGrow: 1, minHeight: 0, width: '100%', fontFamily: nativeTheme.fontMono }} />
          )}
        </div>
      </div>
    </div>
  )
}

function DiffFileList({ files, selectedPath, onSelect }: { files: WorkspaceDiffFile[]; selectedPath: string | undefined; onSelect(path: string | undefined): void }) {
  return (
    <div testId="diff-file-list-panel" style={{ width: 178, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <NativeVirtualList alignment="top" estimatedItemHeight={34} overdraw={120} style={{ flexGrow: 1, minHeight: 0, width: '100%', padding: 6 }}>
        <DiffFileRow label="All changes" active={!selectedPath} additions={files.reduce((sum, file) => sum + file.additions, 0)} deletions={files.reduce((sum, file) => sum + file.deletions, 0)} onClick={() => onSelect(undefined)} />
        {files.map((file) => (
          <DiffFileRow key={file.path} label={file.path} active={file.path === selectedPath} additions={file.additions} deletions={file.deletions} onClick={() => onSelect(file.path)} />
        ))}
      </NativeVirtualList>
    </div>
  )
}

function DiffFileRow({ label, active, additions, deletions, onClick }: { label: string; active: boolean; additions: number; deletions: number; onClick(): void }) {
  return (
    <div testId="diff-file-row" tabIndex={0} style={{ height: 34, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 7, paddingRight: 6, borderRadius: 7, backgroundColor: active ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter') onClick() }}>
      <Icon name="fileDiff" size={12} color={active ? colors.textMuted : colors.textFaint} />
      <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 9, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontMono }}>{label}</text>
      {additions > 0 && <text style={{ color: colors.success, fontSize: 8, fontFamily: nativeTheme.fontMono }}>{`+${additions}`}</text>}
      {deletions > 0 && <text style={{ color: colors.error, fontSize: 8, fontFamily: nativeTheme.fontMono }}>{`−${deletions}`}</text>}
    </div>
  )
}

function PanelMessage({ icon, title, detail }: { icon: 'refresh' | 'fileDiff' | 'check'; title: string; detail?: string }) {
  return (
    <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, paddingLeft: 30, paddingRight: 30 }}>
      <Icon name={icon} size={18} color={colors.textFaint} />
      <text style={{ color: colors.textFaint, fontSize: 11, textAlign: 'center', fontFamily: nativeTheme.fontMono }}>{title}</text>
      {detail && <text style={{ color: colors.textFaint, fontSize: 9, lineHeight: 14, textAlign: 'center', lineClamp: 3, fontFamily: nativeTheme.fontMono }}>{detail}</text>}
    </div>
  )
}

function cleanError(error: string): string {
  const firstLine = error.split('\n').find(Boolean) ?? error
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine
}
