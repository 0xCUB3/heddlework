import React from 'react'
import { basename } from 'node:path'
import { resolvePiExecutable } from '../pi/rpc-transport.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button } from './primitives.tsx'
import { openPath } from './open-external.ts'
import { colors } from './theme.ts'

export function SettingsView({ state, controller, onClose }: { state: WorkbenchState; controller: WorkbenchController; onClose(): void }) {
  return (
    <div style={{ height: '100%', minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', backgroundColor: colors.background }}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: 18, paddingRight: 16, borderWidth: 1, borderColor: colors.border }}>
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Settings</text>
        <div style={{ flexGrow: 1 }} />
        <Button label="Done" compact onClick={onClose} />
      </div>
      <div style={{ flexGrow: 1, overflow: 'scroll', display: 'flex', flexDirection: 'row', justifyContent: 'center', padding: 28 }}>
        <div style={{ width: '100%', maxWidth: 720, display: 'flex', flexDirection: 'column', gap: 24 }}>
          <SettingsSection title="Connection" description="Pi runs as an isolated RPC sidecar for this native window.">
            <SettingsRow icon="terminal" label="Pi executable" value={resolvePiExecutable()} />
            <SettingsRow icon="circle" label="Status" value={state.connectionMessage} tone={state.connection === 'connected' ? 'success' : 'normal'} />
            <SettingsActions>
              <Button label="Reconnect" compact icon="refresh" onClick={() => void controller.reconnect()} />
            </SettingsActions>
          </SettingsSection>

          <SettingsSection title="Project" description="The agent process and all coding tools are scoped to this working directory.">
            <SettingsRow icon="folder" label={basename(state.workspacePath) || state.workspacePath} value={state.workspacePath} />
            <SettingsRow icon="terminal" label="Saved threads" value={String(state.sessions.length)} />
            <SettingsActions>
              <Button label="Open in Finder" compact icon="box" onClick={() => openPath(state.workspacePath)} />
              <Button label="Refresh threads" compact icon="refresh" onClick={() => void controller.refreshSessions()} />
            </SettingsActions>
          </SettingsSection>

          <SettingsSection title="Session" description="Pi remains the authoritative source for transcript, model, compaction, and extension state.">
            <SettingsRow icon="sparkles" label="Model" value={state.session.model ? `${state.session.model.provider}/${state.session.model.id}` : 'Not selected'} />
            <SettingsRow icon="wrench" label="Thinking" value={state.session.thinkingLevel} />
            <SettingsRow icon="download" label="Persistence" value={state.session.sessionFile ? 'On' : 'Not yet persisted'} />
            <SettingsActions>
              <Button label="Export HTML" compact icon="download" onClick={() => void controller.exportSession()} />
              <Button label="Compact" compact disabled={state.session.isStreaming} onClick={() => void controller.compact()} />
            </SettingsActions>
          </SettingsSection>

          <SettingsSection title="About" description="A native GPUIX control surface for Pi, visually adapted from the MIT-licensed T3 Code project.">
            <SettingsRow icon="panel" label="Pi Code" value="Alpha" />
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <text style={{ color: colors.text, fontSize: 14, fontWeight: 650 }}>{title}</text>
      <text style={{ color: colors.textMuted, fontSize: 11, lineHeight: 17 }}>{description}</text>
      <div style={{ marginTop: 3, display: 'flex', flexDirection: 'column', borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.card, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

function SettingsRow({ icon, label, value, tone = 'normal' }: { icon: Parameters<typeof Icon>[0]['name']; label: string; value: string; tone?: 'normal' | 'success' }) {
  return (
    <div style={{ minHeight: 46, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 13, paddingRight: 13, borderWidth: 1, borderColor: colors.border }}>
      <Icon name={icon} size={15} color={tone === 'success' ? colors.success : colors.textFaint} />
      <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{label}</text>
      <div style={{ flexGrow: 1 }} />
      <text style={{ color: tone === 'success' ? colors.success : colors.textMuted, fontSize: 11, maxWidth: 390, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{value}</text>
    </div>
  )
}

function SettingsActions({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 7, padding: 9 }}>{children}</div>
}
