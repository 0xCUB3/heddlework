import type { BrowserIntegrationService } from '../browser/integrations.ts'
import { serviceToken, type PluginContext, type WorkbenchPlugin } from '../core/kernel.ts'
import { flowRuntimeToken } from '../flows/plugin.ts'
import { sleepPreventionToken } from '../power/plugin.ts'
import { terminalSessionToken } from '../terminal/plugin.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { createWorkspaceHost, DEFAULT_HOST_BIND, DEFAULT_HOST_PORT, type WorkspaceHost } from './server.ts'
import { TailnetServeService } from './tailnet-serve.ts'
import type { TailscaleCli } from './tailscale-cli.ts'
import { loadOrCreateHostToken } from './token.ts'
import { readRemoteAccessMode, RemoteAccessService, type RemoteAccessMode } from './remote-access.ts'

export interface WorkspaceHostPluginOptions {
  browserIntegrations?: BrowserIntegrationService | undefined
  enabled: boolean
  // Where the chosen mode persists; false keeps it in memory (demo mode and tests).
  preferencePath?: string | false | undefined
  // Set when the environment pins the mode; the settings picker then reports it as locked.
  lockedBy?: string | undefined
  workspacePath: string
  port?: number | undefined
  hostname?: string | undefined
  tokenPath?: string | false | undefined
  token?: string | undefined
  staticRoot?: string | undefined
  tailscaleCli?: TailscaleCli | undefined
}

export const workspaceHostToken = serviceToken<WorkspaceHost | undefined>('workspace-host')
export const remoteAccessToken = serviceToken<RemoteAccessService>('remote-access')
export const tailnetServeToken = serviceToken<TailnetServeService>('tailnet-serve')

export function createWorkspaceHostPlugin(options: WorkspaceHostPluginOptions): WorkbenchPlugin {
  return {
    id: 'workspace-host',
    requires: [workbenchControllerToken, flowRuntimeToken, sleepPreventionToken],
    activate(ctx) {
      const controller = ctx.get(workbenchControllerToken)
      const flows = ctx.get(flowRuntimeToken)
      const sleepPrevention = ctx.get(sleepPreventionToken)
      const port = options.port ?? DEFAULT_HOST_PORT
      const hostname = options.hostname ?? DEFAULT_HOST_BIND
      const initialMode: RemoteAccessMode = options.enabled ? (hostname === '0.0.0.0' || hostname === '::' ? 'network' : 'local') : 'off'
      const preferencePath = options.preferencePath ?? false
      let tailnet: TailnetServeService | undefined
      const service = new RemoteAccessService({
        initialMode,
        preferencePath,
        lockedBy: options.lockedBy,
        start: (mode) => createWorkspaceHost({
          browserIntegrations: options.browserIntegrations,
          sleepPrevention,
          terminals: optionalService(ctx, terminalSessionToken),
          controller,
          flows,
          workspacePath: options.workspacePath,
          port,
          hostname: mode === 'network' ? '0.0.0.0' : DEFAULT_HOST_BIND,
          token: options.token ?? loadOrCreateHostToken(options.tokenPath ?? false),
          staticRoot: options.staticRoot,
          extraHostUrls: () => tailnet?.advertisedHostUrls() ?? [],
        }),
      })
      tailnet = new TailnetServeService({
        preferencePath,
        getHost: () => service.host,
        ...(options.tailscaleCli ? { cli: options.tailscaleCli } : {}),
      })
      const unsubscribe = service.subscribe(() => {
        if (service.getSnapshot().busy) return
        void tailnet?.reconcile()
      })
      ctx.provide(remoteAccessToken, service)
      ctx.provide(tailnetServeToken, tailnet)
      ctx.provide(workspaceHostToken, service.host)
      ctx.effect(() => () => {
        unsubscribe()
        void tailnet?.dispose()
        void service.close()
      })
    },
  }
}

function optionalService<T>(ctx: PluginContext, token: { key: symbol; name: string; _type?: T }): T | undefined {
  try {
    return ctx.get(token)
  } catch {
    return undefined
  }
}

// HEDDLEWORK_HOST and HEDDLEWORK_HOST_BIND pin the mode when set; otherwise the saved preference from Settings applies.
export function hostOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env, preferencePath: string | false = false): { enabled: boolean; port: number; hostname: string; lockedBy?: string | undefined } {
  const port = Number.parseInt(environment.HEDDLEWORK_HOST_PORT ?? '', 10)
  const resolvedPort = Number.isFinite(port) && port >= 0 ? port : DEFAULT_HOST_PORT
  if (environment.HEDDLEWORK_HOST !== undefined || environment.HEDDLEWORK_HOST_BIND !== undefined) {
    return {
      enabled: environment.HEDDLEWORK_HOST === '1',
      port: resolvedPort,
      hostname: environment.HEDDLEWORK_HOST_BIND?.trim() || DEFAULT_HOST_BIND,
      lockedBy: environment.HEDDLEWORK_HOST !== undefined ? 'HEDDLEWORK_HOST' : 'HEDDLEWORK_HOST_BIND',
    }
  }
  const saved = readRemoteAccessMode(preferencePath)
  return {
    enabled: saved !== undefined && saved !== 'off',
    port: resolvedPort,
    hostname: saved === 'network' ? '0.0.0.0' : DEFAULT_HOST_BIND,
  }
}
