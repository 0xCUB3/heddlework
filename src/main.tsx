import { attachOrStartRuntime, runtimeControl } from './runtime/bootstrap.ts'
import { attachRuntimeWorkspaceClient, createRemoteServices, type RemoteClientServices, type RuntimeAttachDescriptor } from './client/runtime-attach.ts'
import { DesktopHostSwitcher, fileSavedHostsBackend } from './client/desktop-host-switcher.ts'
import { SavedHostsStore } from './client/saved-hosts.ts'
import { workbenchLayoutStorage } from './ui/layout-storage.ts'
import React from 'react'
import { render, resetRender, type Root } from '@gpuix/react'
import { dirname, join, resolve } from 'node:path'
import { createWindowOptions } from './window-options.ts'
import { WorkbenchKernel } from './core/kernel.ts'
import { WorkbenchApp } from './ui/app.tsx'
import { shortcutBus } from './ui/shortcuts.ts'
import { isGpuixWindowCloseRace } from './ui/native-window-lifecycle.ts'
import { ThemeManager, themePreferencePath } from './ui/theme-manager.ts'
import { createCoreUiExtension, createCoreUiExtensionPlugin } from './ui/core-extension.tsx'
import { workbenchUiHostPlugin, workbenchUiRegistryToken } from './ui/extensions.ts'
import { coreToolPresentersPlugin, toolPresenterSlot } from './ui/tool-presenters.ts'
import { sessionSidebarCachePath } from './pi/session-catalog.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from './flows/plugin.ts'
import { flowRuntimePath } from './flows/runtime.ts'
import { FileQueueStore, queueStorePath } from './workbench/queue-store.ts'
import { FileThreadMetadataStore, threadMetadataStorePath } from './workbench/thread-metadata-store.ts'
import { createReceiptPlugin } from './receipts/plugin.ts'
import { createUpdatePlugin, updateServiceToken } from './updates/plugin.ts'
import { createCheckoutLanePlugin } from './workspace/checkout-lanes.ts'
import { receiptStorePath } from './receipts/store.ts'
import { createWorkspaceHostPlugin, hostOptionsFromEnvironment, remoteAccessToken, tailnetServeToken } from './host/plugin.ts'
import { startExternalPlugins } from './plugins/host.ts'
import { resolveStaticRoot } from './host/static-root.ts'
import { hostTokenPath } from './host/token.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from './workbench/plugins.ts'
import { createTerminalPlugin, terminalSessionToken } from './terminal/plugin.ts'
import { createBrowserIntegrationService } from './browser/integrations.ts'
import { browserSessionToken, createBrowserPlugin } from './browser/plugin.ts'
import { createSleepPreventionPlugin, sleepPreventionToken } from './power/plugin.ts'

interface RuntimeHandle {
  kernel: WorkbenchKernel
  dispose(): Promise<void>
}

declare global {
  // eslint-disable-next-line no-var
  var __heddleworkRuntime: RuntimeHandle | undefined
}

const workspacePath = resolveWorkspacePath()
const demoMode = process.env.HEDDLEWORK_DEMO === '1'
const browserSmokeUrl = process.env.HEDDLEWORK_BROWSER_SMOKE_URL
const previous = globalThis.__heddleworkRuntime
const coldStart = previous === undefined
if (previous) await previous.dispose()

const themeManager = new ThemeManager()

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
kernel.mount(createUpdatePlugin({ enabled: demoMode ? false : undefined }))
kernel.mount(createBrowserPlugin({
  ...(demoMode ? { statePath: false as const } : {}),
  cleanupOrphanedProfiles: coldStart,
}))
const updates = kernel.get(updateServiceToken)
const browsers = kernel.get(browserSessionToken)
kernel.mount(createTerminalPlugin({ cwd: workspacePath }))
const terminals = kernel.get(terminalSessionToken)
const descriptor = demoMode || browserSmokeUrl ? undefined : await attachOrStartRuntime({ workspacePath })
const attached = descriptor ? await createRemoteServices(
  attachRuntimeWorkspaceClient({ workspaceUrl: descriptor.url, controlUrl: descriptor.controlUrl, token: descriptor.token }),
  { workspaceUrl: descriptor.url, controlUrl: descriptor.controlUrl, token: descriptor.token },
  { browsers, updates, terminals },
) : undefined
const browserIntegrations = attached?.browserIntegrations ?? createBrowserIntegrationService()
if (!attached) {
  kernel.mount(createWorkbenchControllerPlugin(workspacePath, {
    queueStore: new FileQueueStore(false),
    threadMetadataStore: new FileThreadMetadataStore(false),
  }))
  kernel.mount(createCheckoutLanePlugin())
  kernel.mount(createFlowRuntimePlugin({ path: false, lanesFromKernel: true }))
  const hostOptions = hostOptionsFromEnvironment(process.env, false)
  kernel.mount(createSleepPreventionPlugin({ browserIntegrations, preferencePath: false }))
  kernel.mount(createWorkspaceHostPlugin({ browserIntegrations, enabled: hostOptions.enabled, workspacePath, port: hostOptions.port, hostname: hostOptions.hostname, tokenPath: false, preferencePath: false, staticRoot: resolveStaticRoot() }))
  kernel.mount(createSessionCatalogPlugin({ cachePath: sessionSidebarCachePath() }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createReceiptPlugin({ path: false }))
  kernel.mount(createAgentTransportPlugin({ cwd: workspacePath, demo: demoMode, ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}), piArgs: piArgumentsFromEnvironment() }))
}
kernel.mount(workbenchUiHostPlugin)
if (attached) {
  kernel.mount({ id: 'core-workbench-ui-client', activate(ctx) { return ctx.get(workbenchUiRegistryToken).register(createCoreUiExtension(attached.controller)) } })
} else kernel.mount(createCoreUiExtensionPlugin())

let currentServices = attached
let hostSwitcher: DesktopHostSwitcher | undefined
let root: Root | undefined
if (attached && descriptor) {
  const localDescriptor: RuntimeAttachDescriptor = {
    workspaceUrl: descriptor.url,
    controlUrl: descriptor.controlUrl,
    token: descriptor.token,
  }
  hostSwitcher = new DesktopHostSwitcher({
    local: { descriptor: localDescriptor },
    savedHosts: new SavedHostsStore(fileSavedHostsBackend(join(dirname(hostTokenPath()), 'saved-hosts.json'))),
    lastHostPath: join(dirname(hostTokenPath()), 'last-host.json'),
    buildServices: async (next) => {
      const client = attachRuntimeWorkspaceClient({
        workspaceUrl: next.workspaceUrl,
        controlUrl: next.controlUrl ?? next.workspaceUrl,
        token: next.token,
        hostUrls: next.hostUrls,
      })
      try {
        return await createRemoteServices(client, next, {
          browsers,
          updates,
          terminals,
          timeoutMs: next.origin === 'remote' ? 15_000 : undefined,
        })
      } catch (error) {
        client.disconnect()
        throw error
      }
    },
    onServices(services) {
      currentServices = services
      root?.render(renderApp(services))
    },
  })
  await hostSwitcher.start(attached)
  currentServices = hostSwitcher.services() ?? attached
}

const pluginHost = currentServices?.pluginHost ?? (currentServices ? undefined : await startExternalPlugins(kernel, workspacePath, { trustPath: false }))
const controller = currentServices?.controller ?? kernel.get(workbenchControllerToken)
const flows = currentServices?.flows ?? kernel.get(flowRuntimeToken)
const ui = kernel.get(workbenchUiRegistryToken)
const remoteAccess = currentServices?.remoteAccess ?? kernel.get(remoteAccessToken)
const tailnetServe = currentServices?.tailnetServe ?? kernel.get(tailnetServeToken)
const terminalsForApp = currentServices?.terminals ?? terminals
const sleepPrevention = currentServices?.sleepPrevention ?? kernel.get(sleepPreventionToken)
const presenceTimer = currentServices ? setInterval(() => {
  const services = currentServices
  if (!services) return
  const sessionPath = services.controller.getSnapshot().session.sessionFile
  void services.client.send({ type: 'reportPresence', clientId: 'desktop', surface: 'desktop', visibility: 'visible', ...(sessionPath ? { sessionPath } : {}) }).catch(() => undefined)
}, 15_000) : undefined
let disposed = false
const handleUncaughtException = (error: unknown): void => {
  shutdown(isGpuixWindowCloseRace(error) ? undefined : error)
}
const handleUnhandledRejection = (error: unknown): void => {
  shutdown(error)
}
const runtime: RuntimeHandle = {
  kernel,
  dispose: async () => {
    if (disposed) return
    disposed = true
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    process.off('uncaughtException', handleUncaughtException)
    process.off('unhandledRejection', handleUnhandledRejection)
    if (hostSwitcher) await hostSwitcher.dispose()
    else await attached?.dispose()
    if (presenceTimer) clearInterval(presenceTimer)
    browserIntegrations.dispose()
    themeManager.dispose()
    await kernel.dispose()
  },
}
globalThis.__heddleworkRuntime = runtime

let shutdownStarted = false
function shutdown(initialError?: unknown): void {
  if (shutdownStarted) return
  shutdownStarted = true
  void (async () => {
    const failures: unknown[] = []
    if (initialError !== undefined) failures.push(initialError)
    try {
      await runtime.dispose()
    } catch (error) {
      failures.push(error)
    }

    let nativeStopped = false
    try {
      resetRender()
      nativeStopped = true
    } catch (error) {
      nativeStopped = isGpuixWindowCloseRace(error)
      if (!nativeStopped) failures.push(error)
    }

    if (nativeStopped) {
      try {
        browsers.flushRemovedProfileData()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) {
      console.error('[heddlework] shutdown failed', new AggregateError(failures))
    }
    process.exit(failures.length > 0 ? 1 : 0)
  })()
}

process.prependListener('uncaughtException', handleUncaughtException)
process.prependListener('unhandledRejection', handleUnhandledRejection)
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

function renderApp(services: RemoteClientServices | undefined) {
  return (
    <WorkbenchApp
      layoutStorage={workbenchLayoutStorage}
      browserIntegrations={services?.browserIntegrations ?? browserIntegrations}
      sleepPrevention={services?.sleepPrevention ?? sleepPrevention}
      controller={services?.controller ?? controller}
      flows={services?.flows ?? flows}
      remoteAccess={services?.remoteAccess ?? remoteAccess}
      tailnetServe={services?.tailnetServe ?? tailnetServe}
      pluginHost={services?.pluginHost ?? pluginHost}
      terminals={services?.terminals ?? terminalsForApp}
      browsers={browsers}
      presenters={kernel.contributions(toolPresenterSlot)}
      ui={ui}
      themeManager={themeManager}
      updates={updates}
      onQuit={shutdown}
      onStopAllAndQuit={descriptor ? async () => { await runtimeControl(descriptor, '/stop', {}); shutdown() } : undefined}
      hostSwitcher={hostSwitcher}
    />
  )
}

root = render(
  renderApp(currentServices),
  {
    ...createWindowOptions(
      process.platform,
      debugOverlay(),
      browsers.nativeProfileRoot() ?? '',
      browsers.canInitializeNativeBrowser() && process.env.HEDDLEWORK_NATIVE_BROWSER !== '0',
    ),
    ...(browserSmokeUrl ? { focus: false, show: false } : {}),
    onKeyDown: (event) => { shortcutBus.dispatch(event) },
    onTerminated: shutdown,
  },
)

themeManager.start()
void controller.start()
if (browserSmokeUrl) startPackagedBrowserSmoke(browsers, browserSmokeUrl)

function startPackagedBrowserSmoke(service: typeof browsers, url: string): void {
  const initialTabId = service.createTab({ address: url })
  service.setPlacement(initialTabId, { x: 0, y: 0, width: 640, height: 480 }, true)
  let phase: 'initial' | 'commands' | 'profile' | 'private' | 'private-close' | 'complete' = 'initial'
  let profileId: string | undefined
  let privateTabId: string | undefined
  let sawReloadLoading = false
  let privateCloseSettled = false
  let inspectionQueued = false

  const finish = (error?: Error) => {
    if (phase === 'complete') return
    phase = 'complete'
    clearTimeout(timeout)
    unsubscribe()
    if (error) {
      console.error('[heddlework-browser-smoke] failed', error.message)
      shutdown(error)
    } else {
      const snapshot = service.getSnapshot()
      console.log('[heddlework-browser-smoke] passed', JSON.stringify({
        engine: snapshot.engine.kind,
        tabs: snapshot.tabs.length,
        profiles: snapshot.profiles.length,
      }))
      shutdown()
    }
  }

  const inspect = () => {
    inspectionQueued = false
    if (phase === 'complete') return
    const snapshot = service.getSnapshot()
    if (process.env.GPUIX_CEF_DEBUG) {
      console.error('[heddlework-browser-smoke] state', phase, JSON.stringify(snapshot.tabs.map((tab) => ({ id: tab.id, url: tab.url, title: tab.title, status: tab.status, commands: tab.commands.map((command) => command.serial) }))))
    }
    const failed = snapshot.tabs.find((tab) => tab.error)
    if (failed) {
      finish(new Error(failed.error ?? 'Native browser failed'))
      return
    }
    if (!snapshot.engine.available) return

    if (phase === 'initial') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === initialTabId)
      if (tab?.status !== 'ready' || tab.commands.length > 0 || !tab.title.includes('Heddlework Browser Smoke')) return
      phase = 'commands'
      service.command(initialTabId, 'clearData')
      service.command(initialTabId, 'reload')
      return
    }

    if (phase === 'commands') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === initialTabId)
      if (tab?.status === 'loading') sawReloadLoading = true
      if (!sawReloadLoading || tab?.status !== 'ready' || tab.commands.length > 0) return
      phase = 'profile'
      profileId = service.createProfile({ name: 'Smoke Profile', agentAccess: 'denied' })
      service.switchTabProfile(initialTabId, profileId)
      return
    }

    if (phase === 'profile') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === initialTabId)
      if (!profileId || tab?.profileId !== profileId || tab.status !== 'ready' || tab.commands.length > 0) return
      phase = 'private'
      privateTabId = service.createTab({ profileId: 'private', address: url })
      service.setPlacement(privateTabId, { x: 0, y: 0, width: 640, height: 480 }, true)
      return
    }

    if (phase === 'private') {
      const tab = snapshot.tabs.find((candidate) => candidate.id === privateTabId)
      if (tab?.status !== 'ready' || tab.commands.length > 0 || !privateTabId) return
      phase = 'private-close'
      service.closeTab(privateTabId)
      setTimeout(() => {
        privateCloseSettled = true
        scheduleInspection()
      }, 1_000)
      return
    }

    if (phase === 'private-close') {
      if (!privateCloseSettled || snapshot.tabs.some((candidate) => candidate.id === privateTabId)) return
      finish()
    }
  }

  const scheduleInspection = () => {
    if (inspectionQueued || phase === 'complete') return
    inspectionQueued = true
    queueMicrotask(inspect)
  }
  const unsubscribe = service.subscribe(scheduleInspection)
  const timeout = setTimeout(() => finish(new Error(`Timed out during ${phase}`)), 30_000)
  scheduleInspection()
}

function resolveWorkspacePath(): string {
  if (process.env.HEDDLEWORK_CWD) return resolve(process.env.HEDDLEWORK_CWD)
  const argument = process.argv.slice(2).find((value) => value !== '--' && !value.startsWith('-'))
  return resolve(argument ?? process.cwd())
}

function piArgumentsFromEnvironment(): string[] {
  const args: string[] = []
  if (process.env.HEDDLEWORK_PROVIDER) args.push('--provider', process.env.HEDDLEWORK_PROVIDER)
  if (process.env.HEDDLEWORK_MODEL) args.push('--model', process.env.HEDDLEWORK_MODEL)
  if (process.env.HEDDLEWORK_SESSION) args.push('--session', process.env.HEDDLEWORK_SESSION)
  if (process.env.HEDDLEWORK_NO_SESSION === '1') args.push('--no-session')
  return args
}

function debugOverlay(): 'hidden' | 'minimal' | 'full' {
  const value = process.env.HEDDLEWORK_DEBUG_OVERLAY
  return value === 'minimal' || value === 'full' ? value : 'hidden'
}

