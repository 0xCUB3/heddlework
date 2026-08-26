import React, { useEffect, useMemo, useState } from 'react'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkspaceDiff, WorkspaceDiffFile } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { IconButton, NativeVirtualList } from './primitives.tsx'
import { RightPanelHeader, rightPanelStyle } from './right-panel-header.tsx'
import { colors, nativeTheme } from './theme.ts'

export function DiffPanel({
  diff,
  controller,
  fullscreen,
  panelWidth,
  onClose,
  onNewSurface,
  onToggleFullscreen,
}: {
  diff: WorkspaceDiff
  controller: WorkbenchController
  fullscreen: boolean
  panelWidth?: number
  onClose(): void
  onNewSurface(): void
  onToggleFullscreen(): void
}) {
  const [filesOpen, setFilesOpen] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [selectedPath, setSelectedPath] = useState<string | undefined>()
  useEffect(() => {
    if (selectedPath && !diff.files.some((file) => file.path === selectedPath)) setSelectedPath(undefined)
  }, [diff.files, selectedPath])
  const selectedFile = selectedPath ? diff.files.find((file) => file.path === selectedPath) : undefined
  const patch = selectedFile?.patch ?? diff.files.map((file) => file.patch).join('\n')
  const additions = selectedFile?.additions ?? diff.additions
  const deletions = selectedFile?.deletions ?? diff.deletions
  const canvasWidth = useMemo(() => diffCanvasWidth(patch), [patch])

  return (
    <div testId="diff-panel" style={rightPanelStyle(fullscreen, panelWidth)}>
      <RightPanelHeader
        icon="fileDiff"
        title="Diff"
        fullscreen={fullscreen}
        refreshDisabled={diff.status === 'loading'}
        onNew={onNewSurface}
        onRefresh={() => void controller.refreshWorkspaceDiff()}
        onToggleFullscreen={onToggleFullscreen}
        onClose={onClose}
      />
      <div style={{ height: 42, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 10, paddingRight: 10, borderWidth: 1, borderColor: colors.border }}>
        <div style={{ height: 28, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 8, borderRadius: 8, backgroundColor: colors.raised }}>
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 550, fontFamily: nativeTheme.fontMono, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{selectedFile?.path ?? 'Working tree'}</text>
          <Icon name="chevronDown" size={10} color={colors.textFaint} />
        </div>
        <div style={{ flexGrow: 1 }} />
        {diff.files.length > 0 && (
          <>
            <text style={{ color: colors.success, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`+${additions}`}</text>
            <text style={{ color: colors.error, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`−${deletions}`}</text>
          </>
        )}
        <IconButton icon="wrap" label={wordWrap ? 'Disable line wrapping' : 'Enable line wrapping'} testId="diff-wrap-toggle" active={wordWrap} onClick={() => setWordWrap((value) => !value)} />
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
          ) : wordWrap ? (
            <WrappedDiff patch={patch} />
          ) : (
            <div testId="diff-horizontal-scroll" style={{ display: 'flex', flexDirection: 'row', flexGrow: 1, minWidth: 0, minHeight: 0, overflowX: 'scroll', overflowY: 'hidden' }}>
              <diff testId="diff-native" patch={patch} wordDiff scroll maxLines={2_000} theme={nativeTheme} style={{ width: canvasWidth, minWidth: canvasWidth, height: '100%', flexShrink: 0, fontFamily: nativeTheme.fontMono }} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function DiffFileList({ files, selectedPath, onSelect }: { files: WorkspaceDiffFile[]; selectedPath: string | undefined; onSelect(path: string | undefined): void }) {
  return (
    <div testId="diff-file-list-panel" style={{ width: 212, flexShrink: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }}>
      <NativeVirtualList alignment="top" estimatedItemHeight={40} overdraw={160} style={{ flexGrow: 1, minHeight: 0, width: '100%', padding: 6 }}>
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
    <div testId="diff-file-row" tabIndex={0} style={{ height: 40, minWidth: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 8, paddingRight: 7, borderRadius: 7, backgroundColor: active ? colors.raised : colors.transparent, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter') onClick() }}>
      <Icon name="fileDiff" size={13} color={active ? colors.textMuted : colors.textFaint} />
      <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 11, minWidth: 0, flexGrow: 1, whiteSpace: 'nowrap', textOverflow: 'ellipsis', fontFamily: nativeTheme.fontMono }}>{label}</text>
      {additions > 0 && <text style={{ color: colors.success, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`+${additions}`}</text>}
      {deletions > 0 && <text style={{ color: colors.error, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{`−${deletions}`}</text>}
    </div>
  )
}

interface WrappedLine {
  key: string
  oldLine: number | undefined
  newLine: number | undefined
  marker: string
  text: string
  tone: 'normal' | 'add' | 'delete' | 'hunk' | 'file'
}

function WrappedDiff({ patch }: { patch: string }) {
  const rows = useMemo(() => parseWrappedDiff(patch).slice(0, 2_000), [patch])
  return (
    <div testId="diff-wrapped-scroll" style={{ flexGrow: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'scroll', backgroundColor: colors.background, userSelect: 'text', selectionColor: '#4F67D866' }}>
      {rows.map((row) => {
        const background = row.tone === 'add' ? colors.diffAdd : row.tone === 'delete' ? colors.diffDel : row.tone === 'hunk' ? colors.diffHunkBg : colors.transparent
        const foreground = row.tone === 'hunk' ? colors.textMuted : row.tone === 'file' ? colors.text : '#D7D7DC'
        return (
          <React.Fragment key={row.key}>
            <div style={{ minHeight: 19, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'flex-start', backgroundColor: background }}>
              <text style={{ width: 38, flexShrink: 0, color: colors.textFaint, fontSize: 10, lineHeight: 19, textAlign: 'right', fontFamily: nativeTheme.fontMono }}>{row.oldLine ?? ''}</text>
              <text style={{ width: 38, flexShrink: 0, color: colors.textFaint, fontSize: 10, lineHeight: 19, textAlign: 'right', fontFamily: nativeTheme.fontMono }}>{row.newLine ?? ''}</text>
              <text style={{ width: 18, flexShrink: 0, color: row.tone === 'add' ? colors.success : row.tone === 'delete' ? colors.error : colors.textFaint, fontSize: 11, lineHeight: 19, textAlign: 'center', fontFamily: nativeTheme.fontMono }}>{row.marker}</text>
              <text testId="diff-wrapped-code" style={{ minWidth: 0, flexGrow: 1, paddingRight: 10, color: foreground, fontSize: 12, lineHeight: 19, whiteSpace: 'normal', fontFamily: nativeTheme.fontMono }}>{row.text || ' '}</text>
            </div>
          </React.Fragment>
        )
      })}
    </div>
  )
}

export function parseWrappedDiff(patch: string): WrappedLine[] {
  let oldLine: number | undefined
  let newLine: number | undefined
  return patch.split('\n').map((line, index) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      return { key: `${index}:hunk`, oldLine: undefined, newLine: undefined, marker: '·', text: line, tone: 'hunk' }
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const row = { key: `${index}:add`, oldLine: undefined, newLine, marker: '+', text: line.slice(1), tone: 'add' as const }
      if (newLine !== undefined) newLine += 1
      return row
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      const row = { key: `${index}:delete`, oldLine, newLine: undefined, marker: '−', text: line.slice(1), tone: 'delete' as const }
      if (oldLine !== undefined) oldLine += 1
      return row
    }
    if (line.startsWith(' ')) {
      const row = { key: `${index}:normal`, oldLine, newLine, marker: ' ', text: line.slice(1), tone: 'normal' as const }
      if (oldLine !== undefined) oldLine += 1
      if (newLine !== undefined) newLine += 1
      return row
    }
    return { key: `${index}:file`, oldLine: undefined, newLine: undefined, marker: '·', text: line, tone: 'file' }
  })
}

function diffCanvasWidth(patch: string): number {
  const longest = patch.split('\n').slice(0, 2_000).reduce((width, line) => Math.max(width, [...line].length), 0)
  return Math.max(840, Math.min(16_000, 112 + longest * 7.4))
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
