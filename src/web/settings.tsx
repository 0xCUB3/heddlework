import { BrowserIntegrationSettings } from './browser-integrations.tsx'
import { useState, type ReactNode } from 'react'
import type { WorkbenchSnapshot } from '../protocol/index.ts'
import { webUiContract } from './contract.ts'
import { isNativeShell, notifyNativeShell } from './native-shell.ts'
import { requestWorkspaceNotifications } from './notifications.ts'
import { workspaceClient } from './store.ts'
import { applyWebTheme, readStoredWebTheme, resolveWebTheme, storeWebTheme, type WebThemeMode } from './theme.ts'

export function Settings({ state, workspacePath, onDisconnect }: { state: WorkbenchSnapshot; workspacePath: string; onDisconnect: () => void }) {
  const client = workspaceClient()
  const [themeMode, setThemeMode] = useState<WebThemeMode>(() => (typeof localStorage === 'undefined' ? 'system' : readStoredWebTheme()))
  const [notifyEnabled, setNotifyEnabled] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'granted')
  const selectedModel = state.session.model ? `${state.session.model.provider}/${state.session.model.id}` : ''
  const setTheme = (mode: WebThemeMode) => {
    setThemeMode(mode)
    storeWebTheme(mode)
    applyWebTheme(resolveWebTheme(mode))
  }

  return (
    <section className="web-settings-view" aria-label="Settings">
      <div className="web-settings-scroll" data-testid="settings-scroll">
        <div className="web-settings-global" data-testid="settings-global">
          <SettingsSection title="Runtime" description="Live model and session controls for this remote workbench.">
            <SettingRow label="Status" value={state.connectionMessage} />
            <SettingRow label="Workspace" value={workspacePath} />
            <SettingRow label="Activity" value={state.activity} />
            <SettingControlRow label="Model">
              <select value={selectedModel} onChange={(event) => { const [provider, id] = event.target.value.split('/'); if (provider && id) void client.sendAndReport({ type: 'setModel', provider, id }) }}>{state.models.map((model) => <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>{model.name ?? `${model.provider}/${model.id}`}</option>)}</select>
            </SettingControlRow>
            <SettingControlRow label="Thinking">
              <select value={state.session.thinkingLevel} onChange={(event) => void client.sendAndReport({ type: 'setThinkingLevel', level: event.target.value as WorkbenchSnapshot['session']['thinkingLevel'] })}>{state.thinkingLevels.map((level) => <option key={level} value={level}>{level}</option>)}</select>
            </SettingControlRow>
            <SettingControlRow label="Connection">
              <div className="web-settings-controls"><button type="button" onClick={() => window.location.reload()}>Reconnect</button><button type="button" onClick={() => { onDisconnect(); notifyNativeShell('disconnect') }}>Disconnect</button></div>
            </SettingControlRow>
          </SettingsSection>

          <SettingsSection title="Interface" description="Application-wide presentation and navigation defaults.">
            <SettingControlRow label="Appearance">
              <select value={themeMode} onChange={(event) => setTheme(event.target.value as WebThemeMode)}><option value="system">System</option><option value="dark">Dark</option><option value="light">Light</option></select>
            </SettingControlRow>
            <SettingRow label="Text font" value={webUiContract.typography.fontSans} />
            <SettingRow label="Code font" value={webUiContract.typography.fontMono} />
            <SettingRow label="History loading" value="Seamless infinite scroll" />
          </SettingsSection>

          <SettingsSection title="Remote access" description="Connection details and web notification permissions.">
            <SettingRow label="Host" value={workspaceClient().url || 'Unavailable'} />
            <SettingRow label="Install" value={isNativeShell() ? 'Running inside the native web shell.' : 'Use Add to Home Screen or the browser share sheet.'} />
            <SettingRow label="Phone QR" value="Scan the code in the Mac app under Settings → Remote access. This web client is already on the link." />
            <SettingRow label="LAN fallback" value="If local links fail, start the host with HEDDLEWORK_HOST_BIND=0.0.0.0." />
            <SettingControlRow label="Notifications" description="Notify when a turn finishes or an approval appears.">
              <label className="web-settings-switch"><input type="checkbox" checked={notifyEnabled} onChange={() => { void requestWorkspaceNotifications().then(setNotifyEnabled).catch((error) => client.reportError(error)) }} /><span /></label>
            </SettingControlRow>
          </SettingsSection>

          <SettingsSection title="Updates" description="Update installation stays on the desktop host.">
            <SettingRow label="Desktop updates" value="Host only" />
          </SettingsSection>

          <SettingsSection title="Plugins" description="Remote plugin widgets appear only when the host exposes them.">
            <SettingRow label="Plugin management" value="Host controlled" />
          </SettingsSection>

          <SettingsSection title="Terminal" description="Terminal sessions require the local GPUix desktop process.">
            <SettingRow label="Terminal docks" value="Desktop only" />
          </SettingsSection>

          <SettingsSection title="Browser" description="Browser pane and logged-in browser integrations run on the connected host.">
            <div className="web-settings-embed"><BrowserIntegrationSettings /></div>
          </SettingsSection>

          <SettingsSection title="About" description="A native GPUix control surface for Pi, visually adapted from the MIT-licensed T3 Code project.">
            <SettingRow label="Pi Code" value="Alpha" />
            <SettingRow label="Contract" value={`ui-contract v${webUiContract.version}`} />
          </SettingsSection>
          <div className="web-settings-bottom-spacer" />
        </div>
      </div>
    </section>
  )
}

function SettingsSection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  return (
    <section className="web-settings-section">
      <h2 className="web-settings-section-title">{title}</h2>
      <p className="web-settings-section-desc">{description}</p>
      <div className="web-settings-card">{children}</div>
    </section>
  )
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return <div className="web-settings-row"><span className="web-settings-label">{label}</span><span className="web-settings-value">{value}</span></div>
}

function SettingControlRow({ label, description, children }: { label: string; description?: string; children: ReactNode }) {
  return (
    <div className="web-settings-control-row">
      <div className="web-settings-copy">
        <span className="web-settings-label">{label}</span>
        {description ? <p className="web-settings-row-desc">{description}</p> : null}
      </div>
      <div className="web-settings-control">{children}</div>
    </div>
  )
}
