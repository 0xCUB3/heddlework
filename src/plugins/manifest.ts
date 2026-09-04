export const HEDDLEWORK_PLUGIN_API_VERSION = '1'

export interface PluginManifest {
  id: string
  name: string
  version: string
  entry: string
  heddlework: { api: string }
  surfaces?: boolean
}

export function parsePluginManifest(json: unknown, dir: string): PluginManifest {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error(`Invalid plugin manifest in ${dir}/heddlework-plugin.json`)
  const value = json as Record<string, unknown>
  const heddlework = value.heddlework
  if (!heddlework || typeof heddlework !== 'object' || Array.isArray(heddlework)) {
    throw new Error(`Missing heddlework.api in ${dir}/heddlework-plugin.json`)
  }
  const api = (heddlework as Record<string, unknown>).api
  const id = requiredString(value.id, 'id', dir)
  const name = requiredString(value.name, 'name', dir)
  const version = requiredString(value.version, 'version', dir)
  const entry = requiredString(value.entry, 'entry', dir)
  if (typeof api !== 'string' || api.trim() === '') throw new Error(`Missing heddlework.api in ${dir}/heddlework-plugin.json`)
  return {
    id,
    name,
    version,
    entry,
    heddlework: { api: api.trim() },
    ...(typeof value.surfaces === 'boolean' ? { surfaces: value.surfaces } : {}),
  }
}

export function isCompatible(manifest: PluginManifest, apiVersion = HEDDLEWORK_PLUGIN_API_VERSION): boolean {
  return declaredMajor(manifest.heddlework.api) === declaredMajor(apiVersion)
}

function declaredMajor(value: string): number {
  const normalized = value.startsWith('^') ? value.slice(1) : value
  const major = Number(normalized.split('.')[0])
  if (!Number.isFinite(major)) throw new Error(`Invalid plugin API version ${value}`)
  return major
}

function requiredString(value: unknown, field: string, dir: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${field} in ${dir}/heddlework-plugin.json`)
  return value.trim()
}
