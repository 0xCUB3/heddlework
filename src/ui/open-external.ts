import { spawn } from 'node:child_process'

export function openExternal(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', parsed.href] : [parsed.href]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}
