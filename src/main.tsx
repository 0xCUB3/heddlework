import { attachOrStartRuntime, runtimeControl } from './runtime/bootstrap.ts'
import { attachRuntimeWorkspaceClient, createRemoteServices, createShellWorkbenchController, type RemoteClientServices, type RuntimeAttachDescriptor } from './client/runtime-attach.ts'
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
import { PiSessionCatalog, sessionSidebarCachePath } from './pi/session-catalog.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from './flows/plugin.ts'
import { flowRuntimePath } from './flows/runtime.ts'
import type { NoticeKind } from './workbench/notices.ts'
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
// Update notices go to whichever controller is live: the local demo one, or the attached remote one, which can change on host switch.
kernel.mount(createUpdatePlugin({ enabled: demoMode ? false : undefined, notify: (kind, message) => notifyFromActiveController(kind, message) }))
kernel.mount(createBrowserPlugin({
  ...(demoMode ? { statePath: false as const } : {}),
  cleanupOrphanedProfiles: coldStart,
}))
const updates = kernel.get(updateServiceToken)
const browsers = kernel.get(browserSessionToken)
kernel.mount(createTerminalPlugin({ cwd: workspacePath }))
const terminals = kernel.get(terminalSessionToken)
const localOnly = demoMode || Boolean(browserSmokeUrl)
let descriptor: Awaited<ReturnType<typeof attachOrStartRuntime>> | undefined
let attached: RemoteClientServices | undefined
const browserIntegrations = createBrowserIntegrationService()
if (localOnly) {
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
const shell = localOnly ? undefined : createShellWorkbenchController(workspacePath, {
  sessions: new PiSessionCatalog({ cachePath: sessionSidebarCachePath() }).cached(workspacePath),
})
if (shell) {
  kernel.mount({ id: 'core-workbench-ui-client', activate(ctx) { return ctx.get(workbenchUiRegistryToken).register(createCoreUiExtension(shell)) } })
} else kernel.mount(createCoreUiExtensionPlugin())

let currentServices: RemoteClientServices | undefined
function notifyFromActiveController(kind: NoticeKind, message: string): void {
  const active = currentServices?.controller ?? shell ?? (kernel.has(workbenchControllerToken) ? kernel.get(workbenchControllerToken) : undefined)
  active?.notify(kind, message)
}
let hostSwitcher: DesktopHostSwitcher | undefined
let root: Root | undefined

const pluginHost = localOnly ? await startExternalPlugins(kernel, workspacePath, { trustPath: false }) : undefined
const controller = shell ?? kernel.get(workbenchControllerToken)
const flows = kernel.has(flowRuntimeToken) ? kernel.get(flowRuntimeToken) : undefined
const ui = kernel.get(workbenchUiRegistryToken)
const remoteAccess = kernel.has(remoteAccessToken) ? kernel.get(remoteAccessToken) : undefined
const tailnetServe = kernel.has(tailnetServeToken) ? kernel.get(tailnetServeToken) : undefined
const terminalsForApp = terminals
const sleepPrevention = kernel.has(sleepPreventionToken) ? kernel.get(sleepPreventionToken) : undefined
let presenceTimer: ReturnType<typeof setInterval> | undefined
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
  const sleep = services?.sleepPrevention ?? sleepPrevention
  return (
    <WorkbenchApp
      layoutStorage={workbenchLayoutStorage}
      browserIntegrations={services?.browserIntegrations ?? browserIntegrations}
      {...(sleep ? { sleepPrevention: sleep } : {})}
      controller={controller}
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
      onStopAllAndQuit={descriptor ? async () => { await runtimeControl(descriptor!, '/stop', {}); shutdown() } : undefined}
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
if (localOnly) void controller.start()
else void connectRuntime()
if (browserSmokeUrl) startPackagedBrowserSmoke(browsers, browserSmokeUrl)

async function connectRuntime(): Promise<void> {
  descriptor = await attachOrStartRuntime({ workspacePath })
  attached = await createRemoteServices(
    attachRuntimeWorkspaceClient({ workspaceUrl: descriptor.url, controlUrl: descriptor.controlUrl, token: descriptor.token }),
    { workspaceUrl: descriptor.url, controlUrl: descriptor.controlUrl, token: descriptor.token },
    { browsers, updates, terminals },
  )
  shell?.adopt(attached.controller)
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
      shell?.adopt(services.controller)
      root?.render(renderApp(services))
    },
  })
  await hostSwitcher.start(attached)
  currentServices = hostSwitcher.services() ?? attached
  shell?.adopt(currentServices.controller)
  presenceTimer = setInterval(() => {
    const services = currentServices
    if (!services) return
    const sessionPath = services.controller.getSnapshot().session.sessionFile
    void services.client.send({ type: 'reportPresence', clientId: 'desktop', surface: 'desktop', visibility: 'visible', ...(sessionPath ? { sessionPath } : {}) }).catch(() => undefined)
  }, 15_000)
  root?.render(renderApp(currentServices))
}

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

