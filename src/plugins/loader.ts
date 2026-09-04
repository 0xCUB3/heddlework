import { resolve } from 'node:path'
import type { WorkbenchKernel } from '../core/kernel.ts'
import type { Cleanup, WorkbenchPlugin } from '../core/kernel.ts'
import { pathToFileURL } from 'node:url'
import { HEDDLEWORK_PLUGIN_API_VERSION, isCompatible } from './manifest.ts'
import type { DiscoveredPlugin } from './discovery.ts'

export type PluginLoadStatus = 'loaded' | 'incompatible' | 'error' | 'skipped'

export interface PluginLoadEntry {
  id: string
  name?: string
  version?: string
  source: DiscoveredPlugin['source']
  status: PluginLoadStatus
  error?: string
}

export interface PluginLoadReport {
  workspaceTrusted: boolean
  entries: PluginLoadEntry[]
}

export interface LoadExternalPluginsOptions {
  apiVersion?: string
  workspaceTrusted: boolean
}

export async function loadExternalPlugins(
  kernel: WorkbenchKernel,
  discovered: DiscoveredPlugin[],
  options: LoadExternalPluginsOptions,
): Promise<{ report: PluginLoadReport; unloads: Cleanup[] }> {
  const apiVersion = options.apiVersion ?? HEDDLEWORK_PLUGIN_API_VERSION
  const entries: PluginLoadEntry[] = []
  const unloads: Cleanup[] = []
  const api = await import('../plugin-api.ts')

  for (const item of discovered) {
    if (item.error || !item.manifest) {
      entries.push({ id: item.dir, source: item.source, status: 'error', error: item.error ?? 'Invalid plugin manifest' })
      continue
    }
    const manifest = item.manifest
    if (item.source === 'workspace' && !options.workspaceTrusted) {
      entries.push({ id: manifest.id, name: manifest.name, version: manifest.version, source: item.source, status: 'skipped', error: 'Workspace is not trusted' })
      continue
    }
    if (!isCompatible(manifest, apiVersion)) {
      entries.push({ id: manifest.id, name: manifest.name, version: manifest.version, source: item.source, status: 'incompatible', error: `incompatible api ${manifest.heddlework.api}` })
      continue
    }
    try {
      const plugin = await importPlugin(resolve(item.dir, manifest.entry), api)
      unloads.push(kernel.mount(plugin))
      entries.push({ id: manifest.id, name: manifest.name, version: manifest.version, source: item.source, status: 'loaded' })
    } catch (error) {
      entries.push({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        source: item.source,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { report: { workspaceTrusted: options.workspaceTrusted, entries }, unloads }
}

async function importPlugin(entryPath: string, api: typeof import('../plugin-api.ts')): Promise<WorkbenchPlugin> {
  const module = await import(pathToFileURL(entryPath).href) as { default?: unknown }
  const exported = module.default
  const plugin = typeof exported === 'function' ? exported(api) : exported
  if (!plugin || typeof plugin !== 'object' || typeof (plugin as WorkbenchPlugin).id !== 'string' || typeof (plugin as WorkbenchPlugin).activate !== 'function') {
    throw new Error(`Plugin entry must default-export a WorkbenchPlugin or factory: ${entryPath}`)
  }
  return plugin as WorkbenchPlugin
}
