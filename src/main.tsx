import React from 'react'
import { render } from '@gpuix/react'
import { resolve } from 'node:path'
import { createWindowOptions } from './window-options.ts'
import { WorkbenchKernel } from './core/kernel.ts'
import { WorkbenchApp } from './ui/app.tsx'
import { isGpuixWindowCloseRace } from './ui/native-window-lifecycle.ts'
import { ThemeManager } from './ui/theme-manager.ts'
import { createCoreUiExtensionPlugin } from './ui/core-extension.tsx'
import { workbenchUiHostPlugin, workbenchUiRegistryToken } from './ui/extensions.ts'
import { coreToolPresentersPlugin, toolPresenterSlot } from './ui/tool-presenters.ts'
import { sessionSidebarCachePath } from './pi/session-catalog.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from './flows/plugin.ts'
import { flowRuntimePath } from './flows/runtime.ts'
import { FileQueueStore, queueStorePath } from './workbench/queue-store.ts'
import { FileThreadMetadataStore, threadMetadataStorePath } from './workbench/thread-metadata-store.ts'
import { createReceiptPlugin } from './receipts/plugin.ts'
import { createCheckoutLanePlugin } from './workspace/checkout-lanes.ts'
import { receiptStorePath } from './receipts/store.ts'
import { createWorkspaceHostPlugin, hostOptionsFromEnvironment, workspaceHostToken } from './host/plugin.ts'
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
const previous = globalThis.__heddleworkRuntime
if (previous) await previous.dispose()

const themeManager = new ThemeManager()

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
kernel.mount(createWorkbenchControllerPlugin(workspacePath, {
  queueStore: new FileQueueStore(demoMode ? false : queueStorePath()),
  threadMetadataStore: new FileThreadMetadataStore(demoMode ? false : threadMetadataStorePath()),
}))
kernel.mount(createCheckoutLanePlugin())
kernel.mount(createFlowRuntimePlugin({ path: demoMode ? false : flowRuntimePath(), lanesFromKernel: true }))
const hostOptions = hostOptionsFromEnvironment()
kernel.mount(createWorkspaceHostPlugin({
  enabled: hostOptions.enabled,
  workspacePath,
  port: hostOptions.port,
  hostname: hostOptions.hostname,
  tokenPath: demoMode ? false : hostTokenPath(),
  staticRoot: resolveStaticRoot(),
}))
kernel.mount(createCoreUiExtensionPlugin())
kernel.mount(workbenchUiHostPlugin)
kernel.mount(createSessionCatalogPlugin({ cachePath: sessionSidebarCachePath() }))
kernel.mount(localWorkspaceDiffPlugin)
kernel.mount(createReceiptPlugin({ path: demoMode ? false : receiptStorePath() }))
kernel.mount(createAgentTransportPlugin({
  cwd: workspacePath,
  demo: demoMode,
  ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}),
  piArgs: piArgumentsFromEnvironment(),
}))
const pluginHost = await startExternalPlugins(kernel, workspacePath, { trustPath: demoMode ? false : undefined })

const controller = kernel.get(workbenchControllerToken)
const flows = kernel.get(flowRuntimeToken)
const ui = kernel.get(workbenchUiRegistryToken)
const host = kernel.get(workspaceHostToken)
let disposed = false
const handleUncaughtException = (error: unknown): void => {
  if (isGpuixWindowCloseRace(error)) process.exit(0)

  process.off('uncaughtException', handleUncaughtException)
  throw error
}
const runtime: RuntimeHandle = {
  kernel,
  dispose: async () => {
    if (disposed) return
    disposed = true
    process.off('SIGINT', shutdown)
    process.off('SIGTERM', shutdown)
    process.off('uncaughtException', handleUncaughtException)
    themeManager.dispose()
    await kernel.dispose()
  },
}
globalThis.__heddleworkRuntime = runtime

const shutdown = () => {
  void runtime.dispose().finally(() => process.exit(0))
}

render(
  <WorkbenchApp controller={controller} flows={flows} host={host} pluginHost={pluginHost} presenters={kernel.contributions(toolPresenterSlot)} ui={ui} themeManager={themeManager} onQuit={shutdown} />,
  createWindowOptions(process.platform, debugOverlay()),
)

themeManager.start()
void controller.start()

process.prependListener('uncaughtException', handleUncaughtException)
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

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
