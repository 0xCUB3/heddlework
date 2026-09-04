import { serviceToken, type Cleanup, type WorkbenchPlugin } from '../core/kernel.ts'
import type { WorkbenchKernel } from '../core/kernel.ts'
import { defaultPluginRoots, discoverPlugins } from './discovery.ts'
import { loadExternalPlugins, type PluginLoadReport } from './loader.ts'
import { HEDDLEWORK_PLUGIN_API_VERSION } from './manifest.ts'
import { isWorkspaceTrusted, setWorkspaceTrusted } from './trust.ts'

export interface PluginHost {
  getReport(): PluginLoadReport
  subscribe(listener: () => void): () => void
  setWorkspaceTrusted(trusted: boolean): Promise<void>
}

export const pluginReportToken = serviceToken<PluginHost>('plugin-report')

export function emptyPluginHost(workspaceTrusted = false): PluginHost {
  const report = { workspaceTrusted, entries: [] }
  return {
    getReport: () => report,
    subscribe: () => () => undefined,
    setWorkspaceTrusted: async () => undefined,
  }
}

export async function startExternalPlugins(kernel: WorkbenchKernel, workspacePath: string, options: { trustPath?: string | false | undefined; environment?: NodeJS.ProcessEnv | undefined } = {}): Promise<PluginHost> {
  const listeners = new Set<() => void>()
  let unloads: Cleanup[] = []
  let report: PluginLoadReport = { workspaceTrusted: false, entries: [] }

  const reload = async (): Promise<void> => {
    for (const unload of [...unloads].reverse()) await unload()
    unloads = []
    const trusted = isWorkspaceTrusted(workspacePath, { path: options.trustPath, environment: options.environment })
    const loaded = await loadExternalPlugins(kernel, discoverPlugins(defaultPluginRoots(workspacePath)), {
      apiVersion: HEDDLEWORK_PLUGIN_API_VERSION,
      workspaceTrusted: trusted,
    })
    unloads = loaded.unloads
    report = loaded.report
    for (const listener of listeners) listener()
  }

  await reload()

  const host: PluginHost = {
    getReport: () => report,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async setWorkspaceTrusted(trusted) {
      setWorkspaceTrusted(workspacePath, trusted, options.trustPath ?? false)
      await reload()
    },
  }

  kernel.mount({
    id: 'plugin-report',
    activate(ctx) {
      ctx.provide(pluginReportToken, host)
      ctx.effect(() => () => {
        const pending = unloads
        unloads = []
        void Promise.all(pending.map((unload) => unload()))
      })
    },
  })

  return host
}

export function createPluginReportPlugin(host: PluginHost): WorkbenchPlugin {
  return {
    id: 'plugin-report',
    activate(ctx) {
      ctx.provide(pluginReportToken, host)
    },
  }
}
