import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { PROTOCOL_VERSION } from '../protocol/version.ts'
import { acquireProcessLock, processAlive } from './process-lock.ts'
import { privateDirectory, runtimeDirectory, type RuntimeDescriptor } from './paths.ts'

export interface RuntimeStatus { instanceId: string; busy: boolean; protocol: number; version: string }
export interface AttachRuntimeOptions {
  workspacePath: string
  directory?: string
  executable?: string
  supervisor?: 'launchd' | 'process'
  timeoutMs?: number
  // Installer-only: stage and replace an idle runtime whose executable identity differs.
  // App attach leaves this unset so a compatible live runtime is reused without hashing.
  refresh?: boolean
  busyWaitMs?: number
}

export class RuntimeUpgradeDeferredError extends Error {
  override readonly name = 'RuntimeUpgradeDeferredError'
  readonly protocol: number
  constructor(message: string, protocol: number) {
    super(message)
    this.protocol = protocol
  }
}

export async function runtimeControl<T>(descriptor: RuntimeDescriptor, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${descriptor.controlUrl}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${descriptor.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(await response.text())
  return await response.json() as T
}

export async function discoverRuntime(directory: string): Promise<RuntimeDescriptor | undefined> {
  try {
    const descriptor = JSON.parse(readFileSync(join(directory, 'connection.json'), 'utf8')) as RuntimeDescriptor
    if (!processAlive(descriptor.pid) || !descriptor.token || !descriptor.controlUrl) return undefined
    const status = await runtimeControl<RuntimeStatus>(descriptor, '/status')
    if (status.instanceId !== descriptor.instanceId) return undefined
    return { ...descriptor, protocol: status.protocol, version: status.version }
  } catch { return undefined }
}

function deferredUpgradeMessage(protocol: number, reason: 'busy' | 'unavailable'): string {
  const compatibility = protocol === PROTOCOL_VERSION
    ? 'The live runtime is still on the previous build'
    : `The running agents use protocol ${protocol}; this app uses ${PROTOCOL_VERSION}`
  if (reason === 'unavailable') return `${compatibility}. The live runtime cannot upgrade in place, so the update will wait until agents stop.`
  return `${compatibility}. Agents are busy, so the runtime update will wait.`
}

async function postRuntimeUpgrade(descriptor: RuntimeDescriptor): Promise<'accepted' | 'busy' | 'unavailable'> {
  const response = await fetch(`${descriptor.controlUrl}/upgrade`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  })
  if (response.status === 409) return 'busy'
  if (response.status === 501) return 'unavailable'
  if (!response.ok) throw new Error(await response.text())
  return 'accepted'
}

async function waitUntilIdle(existing: RuntimeDescriptor, busyWaitMs: number): Promise<RuntimeStatus> {
  const deadline = Date.now() + Math.max(0, busyWaitMs)
  while (true) {
    const status = await runtimeControl<RuntimeStatus>(existing, '/status')
    if (status.instanceId !== existing.instanceId) throw new Error('The background runtime was replaced during upgrade')
    if (!status.busy) return status
    if (Date.now() >= deadline) throw new RuntimeUpgradeDeferredError(deferredUpgradeMessage(status.protocol, 'busy'), status.protocol)
    await Bun.sleep(100)
  }
}

async function requestIdleUpgrade(existing: RuntimeDescriptor, busyWaitMs: number): Promise<void> {
  const status = await waitUntilIdle(existing, busyWaitMs)
  let result = await postRuntimeUpgrade(existing)
  if (result === 'busy' && busyWaitMs > 0) {
    await waitUntilIdle(existing, Math.min(1_000, busyWaitMs))
    result = await postRuntimeUpgrade(existing)
  }
  if (result === 'busy') throw new RuntimeUpgradeDeferredError(deferredUpgradeMessage(status.protocol, 'busy'), status.protocol)
  if (result === 'unavailable') throw new RuntimeUpgradeDeferredError(deferredUpgradeMessage(status.protocol, 'unavailable'), status.protocol)
}

async function waitForPidExit(pid: number, timeoutMs: number, log: string): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`The previous background runtime did not exit after upgrade. See ${log}`)
    await Bun.sleep(50)
  }
}

export function stageRuntimeExecutable(source: string, directory: string): string {
  const digest = createHash('sha256').update(readFileSync(source))
  const resources = join(dirname(source), 'web')
  const hashResources = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      digest.update(entry.name)
      const path = join(directory, entry.name)
      if (entry.isDirectory()) hashResources(path)
      else if (entry.isFile()) digest.update(readFileSync(path))
      else throw new Error(`Runtime resources must not contain links: ${path}`)
    }
  }
  if (existsSync(resources)) hashResources(resources)
  const hash = digest.digest('hex').slice(0, 24)
  const versionDirectory = join(directory, 'versions', hash)
  const executable = join(versionDirectory, process.platform === 'win32' ? 'heddlework-runtime.exe' : 'heddlework-runtime')
  if (existsSync(executable)) return executable
  privateDirectory(dirname(versionDirectory))
  const temporary = `${versionDirectory}.${process.pid}.tmp`
  privateDirectory(temporary)
  try {
    copyFileSync(source, join(temporary, basename(executable)))
    if (process.platform !== 'win32') chmodSync(join(temporary, basename(executable)), 0o700)
    const web = join(dirname(source), 'web')
    if (existsSync(web)) cpSync(web, join(temporary, 'web'), { recursive: true })
    renameSync(temporary, versionDirectory)
  } finally { rmSync(temporary, { recursive: true, force: true }) }
  return executable
}

async function runtimeSource(directory: string): Promise<string> {
  const packaged = [join(dirname(process.execPath), '../Resources/runtime/heddlework-runtime'), join(dirname(process.execPath), 'runtime/heddlework-runtime'), join(dirname(process.execPath), 'runtime/heddlework-runtime.exe')]
  for (const candidate of packaged) if (existsSync(candidate)) return resolve(candidate)
  const entry = resolve(import.meta.dir, '../host/main.ts')
  if (!existsSync(entry)) throw new Error('The background runtime is missing from this installation. Reinstall Heddlework.')
  const output = join(directory, `build-${process.pid}`, 'heddlework-runtime')
  privateDirectory(dirname(output))
  const result = await Bun.build({ entrypoints: [entry], compile: { outfile: output }, minify: true, define: { __HEDDLEWORK_RUNTIME_CHANNEL__: JSON.stringify('dev') } })
  if (!result.success) throw new Error(`Could not build the background runtime: ${result.logs.join('\n')}`)
  return output
}

export function launchAgentPlist(label: string, executable: string, directory: string, workspacePath: string, environment: Record<string, string>): string {
  const xml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
  const entries = Object.entries({ ...environment, HEDDLEWORK_RUNTIME_DIR: directory, HEDDLEWORK_CWD: workspacePath, HEDDLEWORK_RUNTIME_SUPERVISOR: 'launchd' })
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array><string>${xml(executable)}</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>3</integer><key>WorkingDirectory</key><string>${xml(workspacePath)}</string><key>EnvironmentVariables</key><dict>${entries.map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join('')}</dict><key>StandardOutPath</key><string>${xml(join(directory, 'runtime.log'))}</string><key>StandardErrorPath</key><string>${xml(join(directory, 'runtime.log'))}</string></dict></plist>\n`
}

function runtimeEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const key of ['HOME', 'PATH', 'LANG', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'HEDDLEWORK_PI', 'HEDDLEWORK_PROVIDER', 'HEDDLEWORK_MODEL', 'HEDDLEWORK_DEMO', 'HEDDLEWORK_NO_SESSION', 'HEDDLEWORK_HOST', 'HEDDLEWORK_HOST_PORT', 'HEDDLEWORK_HOST_BIND', 'HEDDLEWORK_SESSION', 'HEDDLEWORK_RUNTIME_TEST', 'PI_CODING_AGENT_DIR']) {
    const value = process.env[key]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function startRuntime(executable: string, directory: string, workspacePath: string, supervisor: 'launchd' | 'process'): void {
  const environment = runtimeEnvironment()
  if (supervisor === 'launchd') {
    const label = `io.github.monotykamary.heddlework.runtime.${createHash('sha256').update(directory).digest('hex').slice(0, 12)}`
    const target = `gui/${process.getuid!()}`
    const agentsDirectory = join(homedir(), 'Library', 'LaunchAgents')
    mkdirSync(agentsDirectory, { recursive: true })
    const path = join(agentsDirectory, `${label}.plist`)
    writeFileSync(path, launchAgentPlist(label, executable, directory, workspacePath, environment), { mode: 0o600 })
    Bun.spawnSync(['launchctl', 'bootout', `${target}/${label}`], { stdout: 'ignore', stderr: 'ignore' })
    const result = Bun.spawnSync(['launchctl', 'bootstrap', target, path], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(`Could not register the Heddlework background service: ${result.stderr.toString()}`)
    return
  }
  const log = openSync(join(directory, 'runtime.log'), 'a', 0o600)
  try {
    const child = spawn(executable, [], { detached: true, cwd: workspacePath, stdio: ['ignore', log, log], env: { ...environment, HEDDLEWORK_RUNTIME_DIR: directory, HEDDLEWORK_CWD: workspacePath, HEDDLEWORK_RUNTIME_SUPERVISOR: 'process' } })
    child.on('error', (error) => console.error('[heddlework-runtime]', error.message))
    child.unref()
  } finally { closeSync(log) }
}

export async function attachOrStartRuntime(options: AttachRuntimeOptions): Promise<RuntimeDescriptor> {
  const directory = options.directory ?? runtimeDirectory()
  privateDirectory(directory)
  const startTimeoutMs = options.timeoutMs ?? 30_000
  const release = await acquireProcessLock(join(directory, 'startup.lock'), options.timeoutMs ?? 90_000)
  try {
    const existing = await discoverRuntime(directory)
    let previous: RuntimeDescriptor | undefined
    let executable: string | undefined
    let workspacePath = options.workspacePath
    let supervisor = options.supervisor ?? (process.env.HEDDLEWORK_RUNTIME_SUPERVISOR === 'process' || process.platform !== 'darwin' ? 'process' : 'launchd')
    if (existing) {
      const compatible = existing.protocol === PROTOCOL_VERSION
      if (compatible && !options.refresh) return existing
      const source = options.executable ?? await runtimeSource(directory)
      executable = stageRuntimeExecutable(source, directory)
      if (compatible && existing.executable === executable) return existing
      previous = existing
      workspacePath = existing.workspacePath || options.workspacePath
      supervisor = existing.supervisor ?? supervisor
      await requestIdleUpgrade(existing, options.busyWaitMs ?? 8_000)
      await waitForPidExit(existing.pid, startTimeoutMs, join(directory, 'runtime.log'))
    } else {
      executable = stageRuntimeExecutable(options.executable ?? await runtimeSource(directory), directory)
    }
    startRuntime(executable, directory, workspacePath, supervisor)
    const deadline = Date.now() + startTimeoutMs
    do {
      const descriptor = await discoverRuntime(directory)
      if (descriptor && (!previous || descriptor.instanceId !== previous.instanceId)) {
        if (descriptor.protocol !== PROTOCOL_VERSION) throw new Error('The background runtime protocol does not match this app')
        return descriptor
      }
      await Bun.sleep(100)
    } while (Date.now() < deadline)
    throw new Error(`The background runtime did not start. See ${join(directory, 'runtime.log')}`)
  } finally { release() }
}
