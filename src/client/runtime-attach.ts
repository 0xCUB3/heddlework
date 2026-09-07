import type { BrowserSessionService } from '../browser/service.ts'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import type { SleepPreventionService } from '../power/service.ts'
import type { PluginHost } from '../plugins/host.ts'
import type { UpdateService } from '../updates/service.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import { RemoteWorkbenchController } from '../dom/remote-controller.ts'
import type { WorkbenchControllerSurface } from '../workbench/controller-surface.ts'
import { WorkspaceClient, type WorkspaceClientView } from '../web/client.ts'
import { ClientFlowRuntime } from './client-flow-runtime.ts'
import type { FlowRuntimeSurface } from '../flows/runtime.ts'
import {
  RuntimeSettingsControl,
  createRuntimeRemoteSettingsFacades,
  type RuntimeRemoteAccessFacade,
  type RuntimeRemoteSettingsFacades,
  type RuntimeTailnetServeFacade,
} from './runtime-settings-control.ts'
import { createClientBrowserIntegrationService, createClientSleepPreventionService } from './client-runtime-services.ts'

/** Credentials the native shell receives from the supervised runtime agent (LaunchAgent / attach-or-start). */
export interface RuntimeAttachDescriptor {
  workspaceUrl: string
  token: string
  hostUrls?: readonly string[] | undefined
  /** HTTP control plane base URL; defaults to workspaceUrl. */
  controlUrl?: string | undefined
}

export interface AttachRuntimeClientOptions {
  client?: WorkspaceClient | undefined
  alternates?: readonly string[] | undefined
}

export function attachRuntimeWorkspaceClient(
  descriptor: RuntimeAttachDescriptor,
  options: AttachRuntimeClientOptions = {},
): WorkspaceClient {
  const client = options.client ?? new WorkspaceClient()
  const alternates = options.alternates ?? descriptor.hostUrls ?? []
  client.connect(descriptor.workspaceUrl, descriptor.token, alternates)
  return client
}

export interface WaitForWorkspaceClientOpenOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}

export function waitForWorkspaceClientOpen(
  client: WorkspaceClient,
  options: WaitForWorkspaceClientOpenOptions = {},
): Promise<WorkspaceClientView> {
  const snapshot = client.getSnapshot()
  if (snapshot.status === 'open' && snapshot.state) return Promise.resolve(snapshot)

  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 120_000
    let timeout: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = client.subscribe(() => {
      const view = client.getSnapshot()
      if (view.status === 'open' && view.state) {
        cleanup()
        resolve(view)
      }
    })
    const onAbort = (): void => {
      cleanup()
      reject(options.signal?.reason ?? new Error('Aborted'))
    }
    const cleanup = (): void => {
      unsubscribe()
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for workspace connection'))
    }, timeoutMs)
    timeout.unref?.()
  })
}

export interface RemoteClientServicesOptions {
  /** GPUIX native browser stays in the desktop process. */
  browsers: BrowserSessionService
  updates?: UpdateService | undefined
  pluginHost?: PluginHost | undefined
  control?: RuntimeSettingsControl | undefined
  terminals?: TerminalSessionService | undefined
  timeoutMs?: number | undefined
}

export interface RemoteClientServices {
  client: WorkspaceClient
  controller: WorkbenchControllerSurface
  flows: FlowRuntimeSurface
  remoteAccess: RuntimeRemoteAccessFacade
  tailnetServe: RuntimeTailnetServeFacade
  browserIntegrations: BrowserIntegrationService
  sleepPrevention: SleepPreventionService
  browsers: BrowserSessionService
  terminals?: TerminalSessionService | undefined
  updates?: UpdateService | undefined
  pluginHost?: PluginHost | undefined
  settings: RuntimeRemoteSettingsFacades
  dispose(): Promise<void>
}

export async function createRemoteServices(
  client: WorkspaceClient,
  descriptor: RuntimeAttachDescriptor,
  options: RemoteClientServicesOptions,
): Promise<RemoteClientServices> {
  await waitForWorkspaceClientOpen(client, { timeoutMs: options.timeoutMs })
  const control = options.control ?? new RuntimeSettingsControl({
    baseUrl: descriptor.controlUrl ?? descriptor.workspaceUrl,
    token: descriptor.token,
  })
  const settings = createRuntimeRemoteSettingsFacades(control)
  const controller = new RemoteWorkbenchController(client)
  const flows = new ClientFlowRuntime(client)
  flows.start()
  const browserIntegrations = createClientBrowserIntegrationService(client)
  const sleepPrevention = createClientSleepPreventionService(client)

  return {
    client,
    controller,
    flows,
    remoteAccess: settings.remoteAccess,
    tailnetServe: settings.tailnetServe,
    browserIntegrations,
    sleepPrevention,
    browsers: options.browsers,
    terminals: options.terminals,
    updates: options.updates,
    pluginHost: options.pluginHost,
    settings,
    dispose: async () => {
      flows.dispose()
      await controller.dispose()
      settings.dispose()
      client.disconnect()
    },
  }
}


