import { createBrowserIntegrationService } from '../browser/integrations.ts'
import { resolve } from 'node:path'
import { WorkbenchKernel } from '../core/kernel.ts'
import { createFlowRuntimePlugin } from '../flows/plugin.ts'
import { flowRuntimePath } from '../flows/runtime.ts'
import { sessionSidebarCachePath } from '../pi/session-catalog.ts'
import { coreToolPresentersPlugin } from '../ui/tool-presenters.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../workbench/plugins.ts'
import { FileQueueStore, queueStorePath } from '../workbench/queue-store.ts'
import { FileThreadMetadataStore, threadMetadataStorePath } from '../workbench/thread-metadata-store.ts'
import { createReceiptPlugin } from '../receipts/plugin.ts'
import { createCheckoutLanePlugin } from '../workspace/checkout-lanes.ts'
import { receiptStorePath } from '../receipts/store.ts'
import { createSleepPreventionPlugin } from '../power/plugin.ts'
import { createTerminalPlugin } from '../terminal/plugin.ts'
import { themePreferencePath } from '../ui/theme-manager.ts'
import { createWorkspaceHostPlugin, hostOptionsFromEnvironment, tailnetServeToken, workspaceHostToken } from './plugin.ts'
import { bestConnectUrl, hostConnectUrl, remoteConnectUrls } from './server.ts'
import { qrAscii } from '../web/qr.ts'
import { resolveStaticRoot } from './static-root.ts'
import { hostTokenPath } from './token.ts'
import { startExternalPlugins } from '../plugins/host.ts'

// Headless entry: the same kernel as the desktop shell without GPUIX, serving the workspace over the host protocol.
const workspacePath = resolveWorkspacePath()
const demoMode = process.env.HEDDLEWORK_DEMO === '1'
const hostOptions = hostOptionsFromEnvironment()

const kernel = new WorkbenchKernel()
kernel.mount(coreToolPresentersPlugin)
kernel.mount(createWorkbenchControllerPlugin(workspacePath, {
  queueStore: new FileQueueStore(demoMode ? false : queueStorePath()),
  threadMetadataStore: new FileThreadMetadataStore(demoMode ? false : threadMetadataStorePath()),
}))
kernel.mount(createCheckoutLanePlugin())
kernel.mount(createFlowRuntimePlugin({ path: demoMode ? false : flowRuntimePath(), lanesFromKernel: true }))
const browserIntegrations = createBrowserIntegrationService()
kernel.mount(createSleepPreventionPlugin({
  browserIntegrations,
  preferencePath: demoMode ? false : themePreferencePath(),
}))
kernel.mount(createTerminalPlugin({
  cwd: workspacePath,
  ...(demoMode ? { appearancePath: false as const } : {}),
}))
kernel.mount(createWorkspaceHostPlugin({
  browserIntegrations,
  enabled: true,
  workspacePath,
  port: hostOptions.port,
  hostname: hostOptions.hostname,
  preferencePath: demoMode ? false : themePreferencePath(),
  tokenPath: demoMode ? false : hostTokenPath(),
  staticRoot: resolveStaticRoot(),
}))
kernel.mount(createSessionCatalogPlugin({ cachePath: sessionSidebarCachePath() }))
kernel.mount(localWorkspaceDiffPlugin)
kernel.mount(createReceiptPlugin({ path: demoMode ? false : receiptStorePath() }))
kernel.mount(createAgentTransportPlugin({
  cwd: workspacePath,
  demo: demoMode,
  ...(process.env.HEDDLEWORK_PI ? { command: process.env.HEDDLEWORK_PI } : {}),
  piArgs: piArgumentsFromEnvironment(),
}))
await startExternalPlugins(kernel, workspacePath, { trustPath: demoMode ? false : undefined })

const controller = kernel.get(workbenchControllerToken)
const host = kernel.get(workspaceHostToken)
if (!host) throw new Error('Workspace host failed to start')
const tailnet = kernel.get(tailnetServeToken)
await tailnet.idle()
const serveUrl = tailnet.getSnapshot().status === 'ready' ? tailnet.getSnapshot().url : undefined

let disposed = false
const shutdown = (): void => {
  if (disposed) return
  disposed = true
  browserIntegrations.dispose()
  void kernel.dispose().finally(() => process.exit(0))
}
process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

console.log(`Heddlework host serving ${workspacePath}`)
console.log(`  url     ${host.url}`)
console.log(`  connect ${hostConnectUrl(host)}`)
if (serveUrl) console.log(`  tailnet ${bestConnectUrl(host, serveUrl)}`)
for (const remote of remoteConnectUrls(host)) console.log(`  ${remote.kind.padEnd(7)} ${remote.url}`)
if (!demoMode) console.log(`  token   ${hostTokenPath()}`)
const tailnetStatus = tailnet.getSnapshot()
if (tailnetStatus.status !== 'ready' && tailnetStatus.status !== 'idle' && tailnetStatus.message) console.log(`  serve   ${tailnetStatus.message}`)
console.log(qrAscii(bestConnectUrl(host, serveUrl)))
void controller.start()

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
