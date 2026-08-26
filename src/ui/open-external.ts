import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  openSystemTarget(parsed.href)
}

export function openPath(path: string): void {
  openSystemTarget(resolve(path))
}

export function launchWorkspaceWindow(path: string, sessionPath?: string): void {
  const workspace = resolve(path)
  const standalone = typeof Bun !== 'undefined' && Bun.isStandaloneExecutable
  const script = process.argv[1]
  const args = standalone || !script ? [workspace] : [script, workspace]
  const env: NodeJS.ProcessEnv = { ...process.env, PI_WORKBENCH_CWD: workspace }
  if (sessionPath) env.PI_WORKBENCH_SESSION = sessionPath
  else delete env.PI_WORKBENCH_SESSION
  const child = spawn(process.execPath, args, { stdio: 'ignore', detached: true, env })
  child.unref()
}

function openSystemTarget(target: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}
