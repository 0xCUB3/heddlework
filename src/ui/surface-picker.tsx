import React from 'react'
import { Icon, type IconName } from './icons.tsx'
import { IconButton } from './primitives.tsx'
import { colors } from './theme.ts'

export type SurfaceKind = 'browser' | 'terminal' | 'files' | 'diff' | 'agents'

interface SurfaceDescriptor {
  kind: SurfaceKind
  title: string
  description: string
  icon: IconName
}

const SURFACES: SurfaceDescriptor[] = [
  { kind: 'browser', title: 'Browser', description: 'Open a local app or URL.', icon: 'globe' },
  { kind: 'terminal', title: 'Terminal', description: 'Start a shell in this workspace.', icon: 'terminal' },
  { kind: 'files', title: 'Files', description: 'Browse and read workspace files.', icon: 'files' },
  { kind: 'diff', title: 'Diff', description: 'Review working-tree changes.', icon: 'fileDiff' },
  { kind: 'agents', title: 'Agents', description: 'Watch subagents and workflows run.', icon: 'bot' },
]

export function SurfacePickerPanel({ onSelect, onClose }: { onSelect(surface: SurfaceKind): void; onClose(): void }) {
  return (
    <PanelFrame testId="surface-picker" onClose={onClose}>
      <div style={{ flexGrow: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 22 }}>
        <text style={{ color: colors.text, fontSize: 14, fontWeight: 550 }}>Open a surface</text>
        <text style={{ color: colors.textFaint, fontSize: 10, marginTop: 7 }}>Choose what to show in the right panel.</text>
        <div style={{ width: '100%', maxWidth: 430, display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 9, marginTop: 24 }}>
          {SURFACES.map((surface) => (
            <SurfaceCard key={surface.kind} surface={surface} onClick={() => onSelect(surface.kind)} />
          ))}
        </div>
      </div>
    </PanelFrame>
  )
}

export function SurfacePlaceholderPanel({ surface, onNew, onClose }: { surface: Exclude<SurfaceKind, 'diff'>; onNew(): void; onClose(): void }) {
  const descriptor = SURFACES.find((candidate) => candidate.kind === surface)!
  return (
    <div testId="surface-placeholder" style={panelStyle()}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 7, paddingLeft: 9, paddingRight: 9 }}>
        <div style={{ height: 28, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 9, paddingRight: 9, borderRadius: 8, backgroundColor: colors.raised }}>
          <Icon name={descriptor.icon} size={13} color={colors.textMuted} />
          <text style={{ color: colors.text, fontSize: 11, fontWeight: 600 }}>{descriptor.title}</text>
        </div>
        <IconButton icon="plus" label="Open a new surface" testId="right-panel-new-tab" onClick={onNew} />
        <div style={{ flexGrow: 1 }} />
        <IconButton icon="x" label={`Close ${descriptor.title} panel`} testId="close-surface" onClick={onClose} />
      </div>
      <div style={{ flexGrow: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 30 }}>
        <Icon name={descriptor.icon} size={22} color={colors.textFaint} />
        <text style={{ color: colors.textMuted, fontSize: 12 }}>{`${descriptor.title} surface`}</text>
        <text style={{ color: colors.textFaint, fontSize: 10, lineHeight: 16, textAlign: 'center' }}>The native tab shell is ready. Runtime integration will land in a later pass.</text>
      </div>
    </div>
  )
}

function PanelFrame({ testId, onClose, children }: { testId: string; onClose(): void; children: React.ReactNode }) {
  return (
    <div testId={testId} style={panelStyle()}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 10, paddingRight: 9 }}>
        <div style={{ width: 30, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: colors.raised }}>
          <Icon name="plus" size={15} color={colors.textMuted} />
        </div>
        <div style={{ flexGrow: 1 }} />
        <IconButton icon="x" label="Close surface picker" testId="close-surface-picker" onClick={onClose} />
      </div>
      {children}
    </div>
  )
}

function SurfaceCard({ surface, onClick }: { surface: SurfaceDescriptor; onClick(): void }) {
  return (
    <div testId={`surface-option-${surface.kind}`} tabIndex={0} style={{ width: '48%', minWidth: 170, minHeight: 92, display: 'flex', flexDirection: 'column', gap: 8, padding: 13, borderRadius: 9, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, cursor: 'pointer', hover: { backgroundColor: colors.hover } }} onClick={onClick} onKeyDown={(event) => { if (event.key === 'enter') onClick() }}>
      <Icon name={surface.icon} size={17} color={colors.text} />
      <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{surface.title}</text>
      <text style={{ color: colors.textFaint, fontSize: 9, lineHeight: 14 }}>{surface.description}</text>
    </div>
  )
}

function panelStyle() {
  return { width: '44%', minWidth: 420, height: '100%', flexShrink: 0, display: 'flex', flexDirection: 'column', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.panel }
}
