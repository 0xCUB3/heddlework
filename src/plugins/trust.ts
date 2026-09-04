import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { trustedWorkspacesPath } from './paths.ts'

export function isWorkspaceTrusted(workspacePath: string, options: { path?: string | false | undefined; environment?: NodeJS.ProcessEnv | undefined } = {}): boolean {
  if ((options.environment ?? process.env).HEDDLEWORK_TRUST_WORKSPACE === '1') return true
  if (options.path === false) return false
  const target = resolve(workspacePath)
  return readTrustedWorkspaces(options.path ?? trustedWorkspacesPath()).includes(target)
}

export function setWorkspaceTrusted(workspacePath: string, trusted: boolean, path: string | false = trustedWorkspacesPath()): void {
  if (path === false) return
  const target = resolve(workspacePath)
  const current = new Set(readTrustedWorkspaces(path))
  if (trusted) current.add(target)
  else current.delete(target)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify({ version: 1, workspaces: [...current] }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

export function readTrustedWorkspaces(path: string): string[] {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown; workspaces?: unknown }
    if (value.version !== 1 || !Array.isArray(value.workspaces)) return []
    return value.workspaces.filter((entry): entry is string => typeof entry === 'string').map((entry) => resolve(entry))
  } catch {
    return []
  }
}
