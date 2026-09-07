// The browser workbench is the desktop WorkbenchApp mounted on the DOM host, fed by a RemoteWorkbenchController.

import { workbenchLayoutStorage } from '../ui/layout-storage.ts'
import React, { useEffect, useMemo, useSyncExternalStore } from 'react'
import { WorkbenchKernel } from '../core/kernel.ts'
import { WorkbenchApp } from '../ui/app.tsx'
import { WorkbenchUiRegistry } from '../ui/extensions.ts'
import { createCoreUiExtension } from '../ui/core-extension-surfaces.tsx'
import { coreToolPresentersPlugin, toolPresenterSlot } from '../ui/tool-presenters.ts'
import { defaultThemeManager } from '../ui/theme-manager.ts'
import { colors } from '../ui/theme.ts'
import { RemoteWorkbenchController, asWorkbenchController } from '../dom/remote-controller.ts'
import { domRenderer, GpuixContext } from '../dom/host.tsx'
import { fontStack } from '../dom/rich.tsx'
import { workspaceClient } from './store.ts'
import { watchWorkspaceNotifications } from './notifications.ts'
import { notifyNativeShell } from './native-shell.ts'

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
const presenters = kernel.contributions(toolPresenterSlot)

function webClientId(): string {
  const key = 'heddlework.clientId'
  const existing = sessionStorage.getItem(key)
  if (existing) return existing
  const id = `web-${crypto.randomUUID()}`
  sessionStorage.setItem(key, id)
  return id
}

export function WebWorkbench() {
  const client = workspaceClient()
  const view = useSyncExternalStore(client.subscribe.bind(client), client.getSnapshot.bind(client), client.getSnapshot.bind(client))
  const theme = useSyncExternalStore(defaultThemeManager.subscribe, defaultThemeManager.getSnapshot)
  const controller = useMemo(() => new RemoteWorkbenchController(client), [client])
  const registry = useMemo(() => {
    const ui = new WorkbenchUiRegistry()
    ui.register(createCoreUiExtension(asWorkbenchController(controller)))
    return ui
  }, [controller])

  useEffect(() => { defaultThemeManager.start() }, [])
  useEffect(() => watchWorkspaceNotifications(client), [client])
  useEffect(() => {
    document.documentElement.style.setProperty('--gx-font-sans', fontStack(theme.fonts.fontSans))
    document.documentElement.style.setProperty('--gx-font-mono', fontStack(theme.fonts.fontMono, true))
    document.documentElement.style.colorScheme = theme.resolved
    document.body.style.background = colors.background
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', colors.background)
  }, [theme])
  useEffect(() => {
    const clientId = webClientId()
    const report = () => {
      const snapshot = client.getSnapshot().state
      const hidden = document.visibilityState === 'hidden'
      void client.send({
        type: 'reportPresence',
        clientId,
        surface: 'web',
        visibility: hidden ? 'hidden' : document.hasFocus() ? 'focused' : 'visible',
        ...(snapshot?.session.sessionFile ? { sessionPath: snapshot.session.sessionFile } : {}),
      }).catch(() => undefined)
    }
    report()
    const timer = window.setInterval(report, 15_000)
    document.addEventListener('visibilitychange', report)
    window.addEventListener('focus', report)
    window.addEventListener('blur', report)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', report)
      window.removeEventListener('focus', report)
      window.removeEventListener('blur', report)
    }
  }, [client, view.state?.session.sessionFile])

  if (view.status !== 'open' || !view.state) {
    return (
      <div testId="web-connect" style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, padding: 32 }}>
        <div style={{ maxWidth: 440, display: 'flex', flexDirection: 'column', gap: 10, padding: 22, borderWidth: 1, borderColor: colors.border, borderRadius: 16, backgroundColor: colors.card, alignItems: 'center' }}>
          <text style={{ color: colors.textFaint, fontSize: 11, fontWeight: 600 }}>HEDDLEWORK REMOTE</text>
          <text style={{ color: colors.text, fontSize: 20, fontWeight: 650, textAlign: 'center' }}>Open your workbench anywhere.</text>
          <text style={{ color: view.lastError ? colors.error : colors.textMuted, fontSize: 12, textAlign: 'center' }}>{view.lastError ?? (view.status === 'connecting' ? 'Connecting…' : 'Not connected. Open a host connect link.')}</text>
        </div>
      </div>
    )
  }

  return (
    <GpuixContext.Provider value={{ renderer: domRenderer }}>
      <WorkbenchApp
        layoutStorage={workbenchLayoutStorage}
        controller={asWorkbenchController(controller)}
        presenters={presenters}
        ui={registry}
        themeManager={defaultThemeManager as never}
        onQuit={() => { client.disconnect(); notifyNativeShell('disconnect') }}
      />
    </GpuixContext.Provider>
  )
}
