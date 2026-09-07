import { createBrowserIntegrationService, type BrowserIntegrationService } from '../browser/integrations.ts'
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
import { FileThreadTitleSettingsStore, threadTitleSettingsPath } from '../workbench/thread-title-settings-store.ts'
import { createPiTitleGenerator } from './title-generator.ts'
import { createReceiptPlugin } from '../receipts/plugin.ts'
import { createCheckoutLanePlugin } from '../workspace/checkout-lanes.ts'
import { receiptStorePath } from '../receipts/store.ts'
import { createSleepPreventionPlugin } from '../power/plugin.ts'
import { createTerminalPlugin } from '../terminal/plugin.ts'
import { themePreferencePath } from '../ui/theme-manager.ts'
import {
  createWorkspaceHostPlugin,
  hostOptionsFromEnvironment,
  remoteAccessToken,
  tailnetServeToken,
  workspaceHostToken,
} from './plugin.ts'
import type { RemoteAccessService } from './remote-access.ts'
import type { TailnetServeService } from './tailnet-serve.ts'
import type { WorkspaceHost } from './server.ts'
import { resolveStaticRoot } from './static-root.ts'
import { hostTokenPath } from './token.ts'
import { startExternalPlugins } from '../plugins/host.ts'
import type { WorkbenchController } from '../workbench/controller.ts'

export interface HeadlessWorkspaceOptions {
  workspacePath?: string | undefined
  demoMode?: boolean | undefined
}

export interface HeadlessWorkspace {
  kernel: WorkbenchKernel
  workspacePath: string
  controller: WorkbenchController
  host: WorkspaceHost
  remoteAccess: RemoteAccessService
  tailnet: TailnetServeService
  browserIntegrations: BrowserIntegrationService
  dispose(): Promise<void>
}

export function resolveHeadlessWorkspacePath(environment: NodeJS.ProcessEnv = process.env, argv: readonly string[] = process.argv): string {
  if (environment.HEDDLEWORK_CWD) return resolve(environment.HEDDLEWORK_CWD)
  const argument = argv.slice(2).find((value) => value !== '--' && !value.startsWith('-'))
  return resolve(argument ?? process.cwd())
}

export function piArgumentsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): string[] {
  const args: string[] = []
  if (environment.HEDDLEWORK_PROVIDER) args.push('--provider', environment.HEDDLEWORK_PROVIDER)
  if (environment.HEDDLEWORK_MODEL) args.push('--model', environment.HEDDLEWORK_MODEL)
  if (environment.HEDDLEWORK_SESSION) args.push('--session', environment.HEDDLEWORK_SESSION)
  if (environment.HEDDLEWORK_NO_SESSION === '1') args.push('--no-session')
  return args
}

export async function createHeadlessWorkspace(options: HeadlessWorkspaceOptions = {}): Promise<HeadlessWorkspace> {
  const workspacePath = options.workspacePath ?? resolveHeadlessWorkspacePath()
  const demoMode = options.demoMode ?? process.env.HEDDLEWORK_DEMO === '1'
  const preferencePath = demoMode ? false : themePreferencePath()
  const hostOptions = hostOptionsFromEnvironment(process.env, preferencePath)

  const kernel = new WorkbenchKernel()
  kernel.mount(coreToolPresentersPlugin)
  kernel.mount(createWorkbenchControllerPlugin(workspacePath, {
    queueStore: new FileQueueStore(demoMode ? false : queueStorePath()),
    threadMetadataStore: new FileThreadMetadataStore(demoMode ? false : threadMetadataStorePath()),
    titleSettingsStore: new FileThreadTitleSettingsStore(demoMode ? false : threadTitleSettingsPath()),
    ...(demoMode ? {} : { titleGenerator: createPiTitleGenerator() }),
  }))
  kernel.mount(createCheckoutLanePlugin())
  kernel.mount(createFlowRuntimePlugin({ path: demoMode ? false : flowRuntimePath(), lanesFromKernel: true }))
  const browserIntegrations = createBrowserIntegrationService()
  kernel.mount(createSleepPreventionPlugin({ browserIntegrations, preferencePath }))
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
    lockedBy: hostOptions.lockedBy,
    preferencePath,
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
  const remoteAccess = kernel.get(remoteAccessToken)
  const tailnet = kernel.get(tailnetServeToken)

  return {
    kernel,
    workspacePath,
    controller,
    host,
    remoteAccess,
    tailnet,
    browserIntegrations,
    dispose: async () => {
      browserIntegrations.dispose()
      await kernel.dispose()
    },
  }
}

