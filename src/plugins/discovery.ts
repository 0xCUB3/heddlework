import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parsePluginManifest, type PluginManifest } from './manifest.ts'
import { pluginStateRoot, workspacePluginRoot } from './paths.ts'

export interface DiscoveredPlugin {
  dir: string
  source: 'state' | 'workspace'
  manifest?: PluginManifest
  error?: string
}

export function defaultPluginRoots(workspacePath: string): Array<{ root: string; source: DiscoveredPlugin['source'] }> {
  return [
    { root: pluginStateRoot(), source: 'state' },
    { root: workspacePluginRoot(workspacePath), source: 'workspace' },
  ]
}

export function discoverPlugins(roots: Array<{ root: string; source: DiscoveredPlugin['source'] }>): DiscoveredPlugin[] {
  const found: DiscoveredPlugin[] = []
  for (const { root, source } of roots) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue
    for (const name of readdirSync(root).toSorted()) {
      const dir = resolve(root, name)
      if (!statSync(dir).isDirectory()) continue
      const manifestPath = join(dir, 'heddlework-plugin.json')
      if (!existsSync(manifestPath)) continue
      try {
        found.push({ dir, source, manifest: parsePluginManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), dir) })
      } catch (error) {
        found.push({ dir, source, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return found
}
