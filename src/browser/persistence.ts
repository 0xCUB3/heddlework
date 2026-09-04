import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PersistedBrowserState } from './types.ts'

export function readBrowserState(path: string | false): PersistedBrowserState | undefined {
  if (!path) return undefined
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.profiles) || !Array.isArray(value.tabs)) return undefined
    const profiles = value.profiles.filter(isRecord) as unknown as PersistedBrowserState['profiles']
    const tabs = value.tabs.filter(isPersistedTab)
    const defaultProfileId = typeof value.defaultProfileId === 'string' ? value.defaultProfileId : 'workspace'
    const activeTabId = typeof value.activeTabId === 'string' ? value.activeTabId : undefined
    return { version: 1, profiles, defaultProfileId, tabs, ...(activeTabId ? { activeTabId } : {}) }
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isPersistedTab(value: unknown): value is PersistedBrowserState['tabs'][number] {
  return isRecord(value)
    && typeof value.id === 'string'
    && value.id.length > 0
    && typeof value.profileId === 'string'
    && typeof value.url === 'string'
    && typeof value.title === 'string'
    && typeof value.createdAt === 'number'
    && Number.isFinite(value.createdAt)
    && typeof value.lastActiveAt === 'number'
    && Number.isFinite(value.lastActiveAt)
}

export function writeBrowserState(path: string | false, state: PersistedBrowserState): void {
  if (!path) return
  try {
    mkdirSync(dirname(path), { recursive: true })
    const temporaryPath = `${path}.tmp`
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, path)
  } catch {
    // Live browser state still works when preferences cannot be persisted.
  }
}

export function browserStatePath(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(browserConfigRoot(platform, environment, home), 'browser.json')
}

export function browserDataRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (environment.HEDDLEWORK_BROWSER_DATA_DIR) return environment.HEDDLEWORK_BROWSER_DATA_DIR
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'Browser')
  if (platform === 'win32') return join(environment.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'Heddlework', 'Browser')
  return join(environment.XDG_DATA_HOME ?? join(home, '.local', 'share'), 'heddlework', 'browser')
}

export function browserProfilesRoot(
  platform: NodeJS.Platform = process.platform,
  environment: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return join(browserDataRoot(platform, environment, home), 'profiles')
}

function browserConfigRoot(platform: NodeJS.Platform, environment: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework')
}
