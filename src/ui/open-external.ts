import { spawn } from 'node:child_process'
import { resolve } from 'node:path'

export interface DirectoryPickerCommand {
  command: string
  args: string[]
}

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

export function directoryPickerCommand(platform: NodeJS.Platform = process.platform): DirectoryPickerCommand | undefined {
  if (platform === 'darwin') {
    return {
      command: '/usr/bin/osascript',
      args: ['-e', 'POSIX path of (choose folder with prompt "Open project in Heddlework")'],
    }
  }
  if (platform === 'win32') {
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$dialog.Description = "Open project in Heddlework"',
      'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $dialog.SelectedPath } else { exit 1 }',
    ].join('; ')
    return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', script] }
  }
  return { command: 'zenity', args: ['--file-selection', '--directory', '--title=Open project in Heddlework'] }
}

export async function pickWorkspaceDirectory(): Promise<string | undefined> {
  const picker = directoryPickerCommand()
  if (!picker) return undefined
  const selected = await captureProcessOutput(picker.command, picker.args)
  const path = selected?.trim()
  return path ? resolve(path) : undefined
}

function openSystemTarget(target: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', target] : [target]
  const child = spawn(command, args, { stdio: 'ignore', detached: true })
  child.unref()
}

function captureProcessOutput(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolveOutput) => {
    let settled = false
    const finish = (value?: string) => {
      if (settled) return
      settled = true
      resolveOutput(value)
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch {
      finish()
      return
    }
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => finish())
    child.on('close', (code) => finish(code === 0 ? Buffer.concat(chunks).toString('utf8') : undefined))
  })
}
