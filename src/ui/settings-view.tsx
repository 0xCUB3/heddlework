import React from 'react'
import { resolvePiExecutable } from '../pi/rpc-transport.ts'
import { hostConnectUrl, lanConnectUrl, type WorkspaceHost } from '../host/server.ts'
import { copyTextToClipboard } from './clipboard-media.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import type { ThemeMode, ThemeSnapshot } from './theme-manager.ts'
import { useResponsiveLayout } from './responsive.tsx'

export function SettingsView({
  state,
  controller,
  host,
  theme,
  onThemeModeChange,
  onClose,
}: {
  state: WorkbenchState
  controller: WorkbenchController
  host?: WorkspaceHost | undefined
  theme: ThemeSnapshot
  onThemeModeChange(mode: ThemeMode): void
  onClose(): void
}) {
  const { mobile, compact, contentGutter } = useResponsiveLayout()
  const titlebarInset = compact ? (process.platform === 'darwin' ? 132 : 54) : 18
  return (
    <div testId="settings-view" style={{ height: '100%', minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', backgroundColor: colors.background }}>
      <div style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: titlebarInset, paddingRight: 16, borderWidth: 1, borderColor: colors.border }}>
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Settings</text>
        <div style={{ flexGrow: 1 }} />
        <Button label="Done" compact onClick={onClose} />
      </div>
      <div testId="settings-scroll" style={{ height: 0, flexGrow: 1, minHeight: 0, overflow: 'scroll', display: 'flex', flexDirection: 'row', justifyContent: 'center', paddingTop: mobile ? 18 : 28, paddingBottom: 52, paddingLeft: mobile ? contentGutter : 28, paddingRight: mobile ? contentGutter : 28 }}>
        <div testId="settings-global" style={{ width: '100%', maxWidth: 720, minHeight: mobile ? 0 : 620, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: mobile ? 20 : 24 }}>
          <SettingsSection title="Runtime" description="Global Pi connection settings for this application.">
            <SettingsRow icon="terminal" label="Pi executable" value={resolvePiExecutable()} />
            <SettingsRow icon="circle" label="Status" value={state.connectionMessage} tone={state.connection === 'connected' ? 'success' : 'normal'} />
            <SettingsActions>
              <Button label="Reconnect" compact icon="refresh" onClick={() => void controller.reconnect()} />
            </SettingsActions>
          </SettingsSection>

          <SettingsSection title="Interface" description="Application-wide presentation and navigation defaults.">
            <SettingsControlRow label="Appearance">
              <ThemeModePicker theme={theme} onChange={onThemeModeChange} />
            </SettingsControlRow>
            <SettingsRow icon="terminal" label="Code font" value={nativeTheme.fontMono} />
            <SettingsRow icon="bell" label="Notifications" value="Interleaved with work traces" />
            <SettingsRow icon="list" label="History loading" value="Seamless infinite scroll" />
          </SettingsSection>

          <SettingsSection title="About" description="A native GPUix control surface for Pi, visually adapted from the MIT-licensed T3 Code project.">
            <SettingsRow testId="settings-alpha" icon="panel" label="Pi Code" value="Alpha" />
          </SettingsSection>
          {host ? (
            <SettingsSection title="Remote access" description="Web and mobile companions connect to this desktop process over the workspace host protocol.">
              <SettingsRow testId="settings-host-url" icon="circle" label="Host" value={host.url} tone="success" />
              <SettingsRow icon="panel" label="Bound to" value={host.hostname === '127.0.0.1' ? 'This computer only' : `${host.hostname} (network)`} />
              {host.hostname === '0.0.0.0' || host.hostname === '::' ? (
                <SettingsRow icon="circle" label="Phone link" value={lanConnectUrl(host)} />
              ) : null}
              <SettingsActions>
                <Button label="Copy connect link" compact onClick={() => void copyTextToClipboard(host.hostname === '0.0.0.0' || host.hostname === '::' ? lanConnectUrl(host) : hostConnectUrl(host)).then((copied) => controller.notify(copied ? 'info' : 'warning', copied ? 'Copied host connect link with token' : 'No system clipboard command is available'))} />
              </SettingsActions>
            </SettingsSection>
          ) : null}
          <div testId="settings-bottom-spacer" style={{ height: 52, flexShrink: 0 }} />
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

function SettingsRow({ icon, label, value, tone = 'normal', testId }: { icon: Parameters<typeof Icon>[0]['name']; label: string; value: string; tone?: 'normal' | 'success'; testId?: string }) {
  const { mobile } = useResponsiveLayout()
  const labelContent = (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10 }}>
      <Icon name={icon} size={15} color={tone === 'success' ? colors.success : colors.textFaint} />
      <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{label}</text>
    </div>
  )
  return (
    <div {...(testId ? { testId } : {})} style={{ minHeight: 46, display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'center', gap: mobile ? 7 : 10, paddingTop: mobile ? 11 : 0, paddingBottom: mobile ? 11 : 0, paddingLeft: 13, paddingRight: 13, borderWidth: 1, borderColor: colors.border }}>
      {labelContent}
      {!mobile && <div style={{ flexGrow: 1 }} />}
      <text style={{ width: mobile ? '100%' : 'auto', color: tone === 'success' ? colors.success : colors.textMuted, fontSize: 11, maxWidth: mobile ? '100%' : 390, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{value}</text>
    </div>
  )
}

function SettingsControlRow({ label, children }: { label: string; children: React.ReactNode }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div style={{ minHeight: 54, display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'center', gap: 12, paddingTop: mobile ? 10 : 0, paddingBottom: mobile ? 10 : 0, paddingLeft: 13, paddingRight: 10, borderWidth: 1, borderColor: colors.border }}>
      <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{label}</text>
      {!mobile && <div style={{ flexGrow: 1 }} />}
      {children}
    </div>
  )
}

function ThemeModePicker({ theme, onChange }: { theme: ThemeSnapshot; onChange(mode: ThemeMode): void }) {
  const options: Array<{ mode: ThemeMode; label: string }> = [
    { mode: 'system', label: `System (${theme.resolved === 'light' ? 'Light' : 'Dark'})` },
    { mode: 'light', label: 'Light' },
    { mode: 'dark', label: 'Dark' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 3, padding: 3, borderRadius: 9, backgroundColor: colors.raised }}>
      {options.map(({ mode, label }) => {
        const active = theme.mode === mode
        return (
          <div
            key={mode}
            testId={`theme-mode-${mode}`}
            tabIndex={0}
            style={{ minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 9, paddingRight: 9, borderRadius: 7, backgroundColor: active ? colors.card : colors.transparent, borderWidth: 1, borderColor: active ? colors.borderStrong : colors.transparent, cursor: 'pointer', userSelect: 'none', hover: { backgroundColor: active ? colors.card : colors.hover } }}
            onClick={() => onChange(mode)}
            onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(mode) }}
          >
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap' }}>{label}</text>
          </div>
        )
      })}
    </div>
  )
}

function SettingsActions({ children }: { children: React.ReactNode }) {
  return <div style={{ minHeight: 48, display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 7, padding: 9 }}>{children}</div>
}
