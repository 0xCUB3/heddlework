import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { arch, hostname, platform } from 'node:os'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import { hostMachineKindFromHints, type HostArch, type HostIdentity, type HostOs } from '../protocol/host-identity.ts'
import { currentAppVersion } from '../updates/version.ts'
import { hostTokenPath } from './token.ts'
import { writePrivateJson } from '../runtime/paths.ts'

export function hostIdentityPath(tokenPath: string = hostTokenPath()): string {
  return join(dirname(tokenPath), 'host-identity.json')
}

export function hostOs(value: NodeJS.Platform = platform()): HostOs {
  if (value === 'darwin' || value === 'linux') return value
  if (value === 'win32') return 'windows'
  return 'unknown'
}

export function hostArch(value: string = arch()): HostArch {
  if (value === 'arm64') return 'arm64'
  if (value === 'x64') return 'x64'
  return 'other'
}

interface ProbeResult { name: string; model?: string | undefined; chassis?: string | undefined; cloud?: boolean | undefined }

// Cheap, synchronous, best-effort. Every failure degrades to the hostname and a generic machine kind.
export function probeMachine(os: HostOs = hostOs(), run: (command: string, args: string[]) => string = runQuiet): ProbeResult {
  const fallback = hostname()
  if (os === 'darwin') {
    const name = run('scutil', ['--get', 'ComputerName']).trim() || fallback
    const model = run('system_profiler', ['SPHardwareDataType', '-detailLevel', 'mini']).match(/Model Name: (.+)/)?.[1]?.trim()
      ?? run('sysctl', ['-n', 'hw.model']).trim()
    return { name, model }
  }
  if (os === 'linux') {
    const chassis = readQuiet('/sys/class/dmi/id/chassis_type') || run('hostnamectl', ['chassis']).trim()
    const vendor = readQuiet('/sys/class/dmi/id/sys_vendor').toLowerCase()
    const cloud = /amazon|google|microsoft|digitalocean|hetzner|qemu|openstack|xen/.test(vendor)
    return { name: readQuiet('/etc/hostname') || fallback, chassis: linuxChassisName(chassis), cloud }
  }
  if (os === 'windows') {
    const chassis = run('powershell', ['-NoProfile', '-Command', '(Get-CimInstance Win32_SystemEnclosure).ChassisTypes']).trim()
    return { name: fallback, chassis: windowsChassisName(chassis) }
  }
  return { name: fallback }
}

export interface HostIdentityOptions {
  // false keeps the id in memory (tests, demo).
  path?: string | false | undefined
  os?: HostOs | undefined
  arch?: HostArch | undefined
  probe?: ProbeResult | undefined
  version?: string | undefined
}

// Loads the persisted machine id or mints one, then combines it with fresh hardware facts.
export function loadOrCreateHostIdentity(options: HostIdentityOptions = {}): HostIdentity {
  const os = options.os ?? hostOs()
  const path = options.path === undefined ? hostIdentityPath() : options.path
  let id: string | undefined
  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { id?: unknown }
      if (typeof parsed.id === 'string' && parsed.id) id = parsed.id
    } catch {
      // First run or unreadable file; mint below.
    }
  }
  if (!id) {
    id = crypto.randomUUID()
    if (path) {
      try { writePrivateJson(path, { id }) } catch { /* Identity still works in memory. */ }
    }
  }
  const probe = options.probe ?? probeMachine(os)
  return {
    id,
    name: probe.name,
    os,
    arch: options.arch ?? hostArch(),
    machine: hostMachineKindFromHints({ os, model: probe.model, chassis: probe.chassis, cloud: probe.cloud, hasDisplay: os === 'darwin' ? true : undefined }),
    version: options.version ?? currentAppVersion(),
    protocol: PROTOCOL_VERSION,
  }
}

function runQuiet(command: string, args: string[]): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_500 })
  } catch {
    return ''
  }
}

function readQuiet(path: string): string {
  try { return readFileSync(path, 'utf8').trim() } catch { return '' }
}

// SMBIOS chassis codes: https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.1.1.pdf table 17
function linuxChassisName(value: string): string {
  const code = Number(value)
  if (Number.isNaN(code)) return value
  if ([8, 9, 10, 11, 14, 31, 32].includes(code)) return 'laptop'
  if ([3, 4, 5, 6, 7, 13, 15, 16, 35, 36].includes(code)) return 'desktop'
  if ([17, 23, 25, 28, 29].includes(code)) return 'server'
  return value
}

function windowsChassisName(value: string): string {
  return linuxChassisName(value.split(/\s+/)[0] ?? '')
}
