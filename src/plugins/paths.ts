import { homedir } from 'node:os'
import { join } from 'node:path'

export function heddleworkStateDir(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework')
}

export function pluginStateRoot(platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv, home?: string): string {
  return join(heddleworkStateDir(platform, environment, home), 'plugins')
}

export function workspacePluginRoot(workspacePath: string): string {
  return join(workspacePath, '.heddlework', 'plugins')
}

export function trustedWorkspacesPath(platform?: NodeJS.Platform, environment?: NodeJS.ProcessEnv, home?: string): string {
  return join(heddleworkStateDir(platform, environment, home), 'trusted-workspaces.json')
}
