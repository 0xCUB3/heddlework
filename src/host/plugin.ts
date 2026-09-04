import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { flowRuntimeToken } from '../flows/plugin.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { createWorkspaceHost, DEFAULT_HOST_BIND, DEFAULT_HOST_PORT, type WorkspaceHost } from './server.ts'
import { loadOrCreateHostToken } from './token.ts'

export interface WorkspaceHostPluginOptions {
  enabled: boolean
  workspacePath: string
  port?: number | undefined
  hostname?: string | undefined
  tokenPath?: string | false | undefined
  token?: string | undefined
  staticRoot?: string | undefined
}

export const workspaceHostToken = serviceToken<WorkspaceHost | undefined>('workspace-host')

export function createWorkspaceHostPlugin(options: WorkspaceHostPluginOptions): WorkbenchPlugin {
  return {
    id: 'workspace-host',
    requires: [workbenchControllerToken, flowRuntimeToken],
    activate(ctx) {
      if (!options.enabled) {
        ctx.provide(workspaceHostToken, undefined)
        return
      }
      const host = createWorkspaceHost({
        controller: ctx.get(workbenchControllerToken),
        flows: ctx.get(flowRuntimeToken),
        workspacePath: options.workspacePath,
        port: options.port ?? DEFAULT_HOST_PORT,
        hostname: options.hostname ?? DEFAULT_HOST_BIND,
        token: options.token ?? loadOrCreateHostToken(options.tokenPath ?? false),
        staticRoot: options.staticRoot,
      })
      ctx.provide(workspaceHostToken, host)
      ctx.effect(() => () => host.close())
    },
  }
}

export function hostOptionsFromEnvironment(environment: NodeJS.ProcessEnv = process.env): { enabled: boolean; port: number; hostname: string } {
  const port = Number.parseInt(environment.HEDDLEWORK_HOST_PORT ?? '', 10)
  return {
    enabled: environment.HEDDLEWORK_HOST === '1',
    port: Number.isFinite(port) && port >= 0 ? port : DEFAULT_HOST_PORT,
    hostname: environment.HEDDLEWORK_HOST_BIND?.trim() || DEFAULT_HOST_BIND,
  }
}
