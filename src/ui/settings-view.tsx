import React, { useEffect, useState, useSyncExternalStore } from 'react'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { BrowserSessionService } from '../browser/service.ts'
import { resolvePiExecutable } from '../pi/rpc-transport.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { Icon } from './icons.tsx'
import { Button } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'
import type { ThemeMode, ThemeSnapshot } from './theme-manager.ts'
import { useResponsiveLayout } from './responsive.tsx'
import { LAYOUT_MOTION_TRANSITION, MotionDiv } from './motion.ts'
import { hostConnectUrl, lanConnectUrl, remoteConnectUrls, type WorkspaceHost } from '../host/server.ts'
import type { PluginHost } from '../plugins/host.ts'
import { copyTextToClipboard } from './clipboard-media.ts'
import type { UpdateService, UpdateState } from '../updates/service.ts'
import type { UpdateChannel } from '../updates/feed.ts'
import { openExternal } from './open-external.ts'



export function SettingsView({
  state,
  controller,
  theme,
  titlebarInset,
  onThemeModeChange,
  terminals,
  browsers,
  host,
  pluginHost,
  updates,
  onClose,
}: {
  state: WorkbenchState
  controller: WorkbenchController
  theme: ThemeSnapshot
  host?: WorkspaceHost | undefined
  pluginHost?: PluginHost | undefined
  updates?: UpdateService | undefined
  titlebarInset?: number | undefined
  onThemeModeChange(mode: ThemeMode): void
  terminals?: TerminalSessionService | undefined
  browsers?: BrowserSessionService | undefined
  onClose(): void
}) {
  const { mobile, compact, contentGutter } = useResponsiveLayout()
  const resolvedTitlebarInset = titlebarInset ?? (compact ? (process.platform === 'darwin' ? 132 : 54) : 18)
  return (
    <div testId="settings-view" style={{ height: '100%', minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', backgroundColor: colors.background }}>
      <MotionDiv initial={false} animate={{ paddingLeft: resolvedTitlebarInset }} transition={LAYOUT_MOTION_TRANSITION} style={{ height: 52, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', paddingLeft: resolvedTitlebarInset, paddingRight: 16, borderWidth: 1, borderColor: colors.border }}>
        <text style={{ color: colors.text, fontSize: 13, fontWeight: 650 }}>Settings</text>
        <div style={{ flexGrow: 1 }} />
        <Button label="Done" compact onClick={onClose} />
      </MotionDiv>
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

          {updates ? <UpdatesSection service={updates} controller={controller} /> : null}
          {updates ? <UpdatesSection service={updates} controller={controller} /> : null}

          <SettingsSection title="About" description="A native GPUix control surface for Pi, visually adapted from the MIT-licensed T3 Code project.">
            <SettingsRow testId="settings-alpha" icon="panel" label="Pi Code" value="Alpha" />
          </SettingsSection>
          {host ? (
            <SettingsSection title="Remote access" description="Web and mobile companions connect to this desktop process over the workspace host protocol.">
              <SettingsRow testId="settings-host-url" icon="circle" label="Host" value={host.url} tone="success" />
              <SettingsRow icon="panel" label="Bound to" value={host.hostname === '127.0.0.1' ? 'This computer only' : `${host.hostname} (network)`} />
              {remoteConnectUrls(host).map((remote) => (
                <SettingsRow key={remote.url} icon="circle" label={remoteLabel(remote.kind)} value={remote.url} />
              ))}
              <SettingsActions>
                <Button label="Copy connect link" compact onClick={() => void copyTextToClipboard(host.hostname === '0.0.0.0' || host.hostname === '::' ? lanConnectUrl(host) : hostConnectUrl(host)).then((copied) => controller.notify(copied ? 'info' : 'warning', copied ? 'Copied host connect link with token' : 'No system clipboard command is available'))} />
              </SettingsActions>
            </SettingsSection>
          ) : null}
          {pluginHost ? <PluginsSection pluginHost={pluginHost} /> : null}
          {terminals ? <TerminalSettings service={terminals} /> : null}
          {browsers ? <BrowserSettings service={browsers} /> : null}

          <SettingsSection title="About" description="A native GPUix control surface for Pi, visually adapted from the MIT-licensed T3 Code project.">
            <SettingsRow testId="settings-alpha" icon="panel" label="Pi Code" value="Alpha" />
          </SettingsSection>
          <div testId="settings-bottom-spacer" style={{ height: 52, flexShrink: 0 }} />
        </div>
      </div>
    </div>
  )
}

export function updateStatusLabel(state: UpdateState): string {
  switch (state.status) {
    case 'disabled': return state.message ?? 'Automatic updates are off'
    case 'idle': return 'Not checked yet'
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return `Up to date (${state.currentVersion})`
    case 'available': return state.install.managedCommand ? `${state.availableVersion} is available. Run: ${state.install.managedCommand}` : `${state.availableVersion} is available`
    case 'downloading': return `Downloading ${state.availableVersion}${typeof state.downloadPercent === 'number' ? ` (${Math.floor(state.downloadPercent)}%)` : ''}…`
    case 'downloaded': return `${state.downloadedVersion} is downloaded. Restart to install it.`
    case 'error': return state.errorContext === 'download' && state.availableVersion ? `Download failed for ${state.availableVersion}: ${state.message ?? 'unknown error'}` : state.errorContext === 'install' && state.downloadedVersion ? `Install failed for ${state.downloadedVersion}: ${state.message ?? 'unknown error'}` : state.message ?? 'Update check failed'
  }
}

export function updateActionLabel(state: UpdateState): 'Check for updates' | 'Download' | 'Restart to update' | 'Retry' | null {
  if (!state.enabled) return null
  if (state.status === 'downloaded') return 'Restart to update'
  if (state.status === 'error') return 'Retry'
  if (state.status === 'available' && !state.install.managedCommand) return 'Download'
  if (state.status === 'checking' || state.status === 'downloading') return null
  return 'Check for updates'
}

function UpdatesSection({ service, controller }: { service: UpdateService; controller: WorkbenchController }) {
  const state = React.useSyncExternalStore(service.subscribe, service.getSnapshot)
  const action = updateActionLabel(state)
  const runAction = () => {
    if (action === 'Restart to update') void service.install()
    else if (action === 'Download') void service.download()
    else if (action === 'Retry') void service.retry()
    else if (action === 'Check for updates') void service.check('manual')
  }
  const setChannel = (channel: UpdateChannel) => {
    void service.setChannel(channel).catch((error: unknown) => controller.notify('warning', error instanceof Error ? error.message : String(error)))
  }
  const tone = state.status === 'up-to-date' || state.status === 'downloaded' ? 'success' : 'normal'
  return (
    <SettingsSection title="Updates" description="Heddlework checks GitHub Releases every few minutes, downloads new builds in the background, and installs when you restart.">
      <SettingsRow testId="settings-update-status" icon="refresh" label={`Version ${state.currentVersion}`} value={updateStatusLabel(state)} tone={tone} />
      {state.arch.translated ? <SettingsRow icon="panel" label="Architecture" value="Running the Intel build under Rosetta; the next update installs the Apple Silicon build." /> : null}
      <SettingsControlRow label="Channel">
        <ChannelPicker channel={state.channel} onChange={setChannel} disabled={service.busy} />
      </SettingsControlRow>
      <SettingsActions>
        {state.releaseUrl ? <Button label="Release notes" compact onClick={() => openExternal(state.releaseUrl!)} /> : null}
        {action ? <Button testId="settings-update-action" label={action} compact {...(action === 'Restart to update' ? { icon: 'refresh' as const } : {})} onClick={runAction} /> : null}
      </SettingsActions>
    </SettingsSection>
  )
}

function ChannelPicker({ channel, onChange, disabled }: { channel: UpdateChannel; onChange(channel: UpdateChannel): void; disabled: boolean }) {
  const options: Array<{ value: UpdateChannel; label: string }> = [
    { value: 'stable', label: 'Stable' },
    { value: 'prerelease', label: 'Prerelease' },
  ]
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 3, padding: 3, borderRadius: 9, backgroundColor: colors.raised, opacity: disabled ? 0.6 : 1 }}>
      {options.map(({ value, label }) => {
        const active = channel === value
        return (
          <div
            key={value}
            testId={`update-channel-${value}`}
            tabIndex={0}
            style={{ minHeight: 28, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 9, paddingRight: 9, borderRadius: 7, backgroundColor: active ? colors.card : colors.transparent, borderWidth: 1, borderColor: active ? colors.borderStrong : colors.transparent, cursor: 'pointer', userSelect: 'none', hover: { backgroundColor: active ? colors.card : colors.hover } }}
            onClick={() => { if (!disabled) onChange(value) }}
            onKeyDown={(event) => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onChange(value) }}
          >
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap' }}>{label}</text>
          </div>
        )
      })}
    </div>
  )
}

function PluginsSection({ pluginHost }: { pluginHost: PluginHost }) {
  const report = React.useSyncExternalStore(pluginHost.subscribe, pluginHost.getReport)
  return (
    <SettingsSection title="Plugins" description="Third-party workbench plugins loaded from the state directory or this workspace.">
      <SettingsRow testId="settings-plugins-empty" icon="panel" label="Workspace" value={report.workspaceTrusted ? 'Trusted' : 'Not trusted'} />
      {report.entries.length === 0 ? (
        <SettingsRow testId="settings-plugins-none" icon="circle" label="External plugins" value="No external plugins" />
      ) : report.entries.map((entry) => (
        <SettingsRow key={entry.id} icon="circle" label={entry.name ?? entry.id} value={`${entry.version ?? ''} ${entry.status}${entry.error ? ` — ${entry.error}` : ''}`.trim()} />
      ))}
      <SettingsActions>
        <Button label={report.workspaceTrusted ? 'Untrust workspace' : 'Trust workspace'} compact onClick={() => void pluginHost.setWorkspaceTrusted(!report.workspaceTrusted)} />
      </SettingsActions>
    </SettingsSection>
  )
}


function remoteLabel(kind: ReturnType<typeof remoteConnectUrls>[number]['kind']): string {
  switch (kind) {
    case 'custom': return 'Phone link'
    case 'tailscale': return 'Tailscale link'
    case 'lan': return 'LAN link'
    case 'other': return 'Network link'
    default: return 'Local link'
  }
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

function SettingsControlRow({ label, description, children }: { label: string; description?: string; children: React.ReactNode }) {
  const { mobile } = useResponsiveLayout()
  return (
    <div style={{ minHeight: 54, display: 'flex', flexDirection: mobile ? 'column' : 'row', alignItems: mobile ? 'stretch' : 'center', gap: 12, paddingTop: mobile ? 10 : 0, paddingBottom: mobile ? 10 : 0, paddingLeft: 13, paddingRight: 10, borderWidth: 1, borderColor: colors.border }}>
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>{label}</text>
        {description ? <text style={{ color: colors.textFaint, fontSize: 9, lineHeight: 13 }}>{description}</text> : null}
      </div>
      {!mobile && <div style={{ flexGrow: 1 }} />}
      {children}
    </div>
  )
}

function BrowserSettings({ service }: { service: BrowserSessionService }) {
  const snapshot = useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
  return (
    <SettingsSection title="Browser" description="App-owned profiles keep browser identities separate. Personal profiles are never exposed to agents; workspace profiles require the policy shown below.">
      <SettingsRow icon="globe" label="Native engine" value={snapshot.engine.available ? snapshot.engine.message : 'Unavailable'} tone={snapshot.engine.available ? 'success' : 'normal'} />
      {snapshot.profiles.map((profile) => (
        <SettingsControlRow key={profile.id} label={profile.name} description={`${profile.persistent ? 'Persistent' : 'Ephemeral'} · Agent access ${profile.agentAccess}`}>
          {profile.id === snapshot.defaultProfileId
            ? <text style={{ color: colors.success, fontSize: 10, fontWeight: 650 }}>Default</text>
            : profile.persistent
              ? <Button label="Make default" compact onClick={() => service.setDefaultProfile(profile.id)} />
              : <text style={{ color: colors.textFaint, fontSize: 10 }}>Private</text>}
        </SettingsControlRow>
      ))}
    </SettingsSection>
  )
}

function TerminalSettings({ service }: { service: TerminalSessionService }) {
  const appearance = useSyncExternalStore(service.subscribe, service.getSnapshot).appearance
  return (
    <SettingsSection title="Terminal" description="Native GPUI text shaping and renderer controls. Font changes apply to every live terminal without restarting its PTY.">
      <SettingsControlRow label="Primary font" description="Use the exact family name of an installed monospaced font.">
        <TerminalFontControl value={appearance.fontFamily} testId="terminal-font-family" onApply={(fontFamily) => service.setAppearance({ fontFamily })} />
      </SettingsControlRow>
      <SettingsControlRow label="Programming ligatures" description="Shape same-style cells together with the selected font's native OpenType features.">
        <SettingsToggle testId="terminal-ligatures" enabled={appearance.ligaturesEnabled} onChange={(ligaturesEnabled) => service.setAppearance({ ligaturesEnabled })} />
      </SettingsControlRow>
      <SettingsControlRow label="Nerd Font symbols" description="Route powerline and private-use glyphs through a separately installed symbol font.">
        <SettingsToggle testId="terminal-nerd-font" enabled={appearance.nerdFontEnabled} onChange={(nerdFontEnabled) => service.setAppearance({ nerdFontEnabled })} />
      </SettingsControlRow>
      <SettingsControlRow label="Nerd Font family" description="Usually Symbols Nerd Font Mono, or the family name supplied by your Nerd Font package.">
        <TerminalFontControl value={appearance.nerdFontFamily} testId="terminal-nerd-font-family" onApply={(nerdFontFamily) => service.setAppearance({ nerdFontFamily })} />
      </SettingsControlRow>
      <SettingsControlRow label="Muted emoji" description="Prefer monochrome text-presentation glyphs so emoji follows terminal foreground colors.">
        <SettingsToggle testId="terminal-muted-emoji" enabled={appearance.muteEmojiColors} onChange={(muteEmojiColors) => service.setAppearance({ muteEmojiColors })} />
      </SettingsControlRow>
      <SettingsActions>
        <Button label="Reset terminal appearance" compact onClick={() => service.resetAppearance()} />
      </SettingsActions>
    </SettingsSection>
  )
}

function TerminalFontControl({ value, testId, onApply }: { value: string; testId: string; onApply(value: string): void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const next = draft.trim()
  return (
    <div style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 0, minWidth: 0, height: 32, flexGrow: 1, display: 'flex', alignItems: 'center', paddingLeft: 9, paddingRight: 9, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input }}>
        <input testId={testId} value={draft} theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }} style={{ width: 0, minWidth: 0, height: 28, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 10, fontFamily: draft || nativeTheme.fontMono }} onChange={(event) => setDraft(String(event.value ?? ''))} onKeyDown={(event) => { if (event.key === 'enter' && next) onApply(next) }} />
      </div>
      <Button testId={`${testId}-apply`} label="Apply" compact disabled={!next || next === value} onClick={() => onApply(next)} />
    </div>
  )
}

function SettingsToggle({ enabled, testId, onChange }: { enabled: boolean; testId: string; onChange(enabled: boolean): void }) {
  return (
    <div testId={testId} style={{ display: 'flex', flexDirection: 'row', gap: 3, padding: 3, borderRadius: 9, backgroundColor: colors.raised }}>
      {[false, true].map((value) => {
        const active = enabled === value
        return (
          <div key={String(value)} testId={`${testId}-${value ? 'on' : 'off'}`} tabIndex={0} style={{ minHeight: 26, minWidth: 42, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 7, borderWidth: 1, borderColor: active ? colors.borderStrong : colors.transparent, backgroundColor: active ? colors.card : colors.transparent, cursor: 'pointer', userSelect: 'none', hover: { backgroundColor: active ? colors.card : colors.hover } }} onClick={() => onChange(value)} onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') onChange(value) }}>
            <text style={{ color: active ? colors.text : colors.textMuted, fontSize: 10, fontWeight: active ? 650 : 500 }}>{value ? 'On' : 'Off'}</text>
          </div>
        )
      })}
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
