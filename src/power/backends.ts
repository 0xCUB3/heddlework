import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  SLEEP_INHIBIT_WHO,
  SLEEP_INHIBIT_WHY,
  sleepPreventionPlatform,
  type SleepPreventionBackendName,
  type SleepPreventionPlatform,
} from './types.ts'

export interface HeldSleepAssertion {
  pid?: number | undefined
  command?: string | undefined
  args?: readonly string[] | undefined
  onUnexpectedExit(listener: () => void): () => void
  release(): Promise<void>
}

export interface SleepBackend {
  readonly name: SleepPreventionBackendName
  readonly displaySupported: boolean
  readonly supported: boolean
  readonly platform: SleepPreventionPlatform
  readonly limits: string
  acquire(options: { keepDisplayAwake: boolean }): Promise<HeldSleepAssertion>
}

export type SleepSpawnFn = (command: string, args: readonly string[], options: {
  stdio: ['pipe', 'ignore', 'pipe']
  detached: false
  windowsHide: true
}) => ChildProcess

const CAFFEINATE = '/usr/bin/caffeinate'
const SYSTEMD_INHIBIT = '/usr/bin/systemd-inhibit'
const CAT = '/bin/cat'

export const DARWIN_LIMITS = 'Prevents idle sleep via caffeinate. Closing the lid, choosing Sleep, or a low battery can still sleep the Mac.'
export const WINDOWS_LIMITS = 'Requests that Windows skip idle sleep through SetThreadExecutionState. Choosing Sleep or closing the lid can still sleep the PC.'
export const LINUX_LIMITS = 'Blocks logind idle and sleep while a session bus is available. Display sleep is compositor-owned and is not claimed. systemd-inhibit is required.'
export const UNSUPPORTED_LIMITS = 'This platform has no supported idle-sleep inhibitor.'

export function caffeinateArgs(options: { keepDisplayAwake: boolean; parentPid: number }): string[] {
  const args = ['-i']
  if (options.keepDisplayAwake) args.push('-d')
  args.push('-w', String(options.parentPid))
  return args
}

export function systemdInhibitArgs(): string[] {
  return [
    '--what=sleep:idle',
    `--who=${SLEEP_INHIBIT_WHO}`,
    `--why=${SLEEP_INHIBIT_WHY}`,
    '--mode=block',
    CAT,
  ]
}

export const ES_CONTINUOUS = 0x80000000 >>> 0
export const ES_SYSTEM_REQUIRED = 0x00000001
export const ES_DISPLAY_REQUIRED = 0x00000002

export function windowsExecutionState(keepDisplayAwake: boolean): number {
  return (ES_CONTINUOUS | ES_SYSTEM_REQUIRED | (keepDisplayAwake ? ES_DISPLAY_REQUIRED : 0)) >>> 0
}

export function createNoopSleepBackend(overrides: Partial<SleepBackend> = {}): SleepBackend {
  const platform = overrides.platform ?? 'other'
  return {
    name: overrides.name ?? 'none',
    displaySupported: overrides.displaySupported ?? false,
    supported: overrides.supported ?? false,
    platform,
    limits: overrides.limits ?? UNSUPPORTED_LIMITS,
    async acquire() {
      throw new Error('Sleep prevention is not available on this platform')
    },
  }
}

export function createRecordingSleepBackend(): SleepBackend & {
  acquires: Array<{ keepDisplayAwake: boolean }>
  releases: number
  active: number
  failNext?: string | undefined
  pids: number[]
} {
  const recording = {
    name: 'none' as const,
    displaySupported: true,
    supported: true,
    platform: 'other' as const,
    limits: 'Test inhibitor.',
    acquires: [] as Array<{ keepDisplayAwake: boolean }>,
    releases: 0,
    active: 0,
    failNext: undefined as string | undefined,
    pids: [] as number[],
    async acquire(options: { keepDisplayAwake: boolean }): Promise<HeldSleepAssertion> {
      if (recording.failNext) {
        const message = recording.failNext
        recording.failNext = undefined
        throw new Error(message)
      }
      recording.acquires.push({ keepDisplayAwake: options.keepDisplayAwake })
      recording.active += 1
      const pid = 10_000 + recording.acquires.length
      recording.pids.push(pid)
      let released = false
      const exitListeners = new Set<() => void>()
      return {
        pid,
        command: 'test-inhibit',
        args: options.keepDisplayAwake ? ['display'] : ['system'],
        onUnexpectedExit(listener) {
          exitListeners.add(listener)
          return () => { exitListeners.delete(listener) }
        },
        async release() {
          if (released) return
          released = true
          recording.releases += 1
          recording.active -= 1
        },
      }
    },
  }
  return recording
}

export function createPlatformSleepBackend(options: {
  platform?: NodeJS.Platform | string | undefined
  parentPid?: number | undefined
  spawn?: SleepSpawnFn | undefined
  exists?: ((path: string) => boolean) | undefined
  windowsSetThreadExecutionState?: ((flags: number) => number) | undefined
} = {}): SleepBackend {
  const platform = sleepPreventionPlatform(options.platform ?? process.platform)
  const exists = options.exists ?? existsSync
  const parentPid = options.parentPid ?? process.pid
  const run = options.spawn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions))

  if (platform === 'darwin') {
    if (!exists(CAFFEINATE)) return createNoopSleepBackend({ platform, name: 'none', limits: DARWIN_LIMITS })
    return {
      name: 'caffeinate',
      displaySupported: true,
      supported: true,
      platform,
      limits: DARWIN_LIMITS,
      acquire: ({ keepDisplayAwake }) => holdChild(run, CAFFEINATE, caffeinateArgs({ keepDisplayAwake, parentPid })),
    }
  }

  if (platform === 'linux') {
    if (!exists(SYSTEMD_INHIBIT) || !exists(CAT)) return createNoopSleepBackend({ platform, name: 'none', limits: LINUX_LIMITS })
    return {
      name: 'systemd-inhibit',
      displaySupported: false,
      supported: true,
      platform,
      limits: LINUX_LIMITS,
      acquire: () => holdChild(run, SYSTEMD_INHIBIT, systemdInhibitArgs(), { closeStdin: true }),
    }
  }

  if (platform === 'win32') {
    const setState = options.windowsSetThreadExecutionState
    if (!setState) return createNoopSleepBackend({ platform, name: 'none', limits: WINDOWS_LIMITS })
    return {
      name: 'execution-state',
      displaySupported: true,
      supported: true,
      platform,
      limits: WINDOWS_LIMITS,
      async acquire({ keepDisplayAwake }) {
        const flags = windowsExecutionState(keepDisplayAwake)
        const previous = setState(flags)
        if (previous === 0) throw new Error('SetThreadExecutionState refused the idle-sleep request')
        let released = false
        return {
          command: 'SetThreadExecutionState',
          args: [String(flags)],
          onUnexpectedExit() {
            return () => undefined
          },
          async release() {
            if (released) return
            released = true
            setState(ES_CONTINUOUS)
          },
        }
      },
    }
  }

  return createNoopSleepBackend({ platform })
}

export async function loadWindowsSetThreadExecutionState(): Promise<((flags: number) => number) | undefined> {
  if (process.platform !== 'win32') return undefined
  try {
    const { dlopen, FFIType } = await import('bun:ffi')
    const kernel32 = dlopen('kernel32.dll', {
      SetThreadExecutionState: {
        args: [FFIType.u32],
        returns: FFIType.u32,
      },
    })
    return (flags) => kernel32.symbols.SetThreadExecutionState(flags) >>> 0
  } catch {
    return undefined
  }
}

async function holdChild(run: SleepSpawnFn, command: string, args: readonly string[], options: { closeStdin?: boolean } = {}): Promise<HeldSleepAssertion> {
  const child = run(command, args, { stdio: ['pipe', 'ignore', 'pipe'], detached: false, windowsHide: true })
  const stderr: Buffer[] = []
  child.stderr?.on('data', (chunk) => {
    if (stderr.length < 8) stderr.push(Buffer.from(chunk))
  })
  const started = await waitForStart(child)
  if (!started.ok) {
    const detail = Buffer.concat(stderr).toString('utf8').trim()
    throw new Error(detail || `${command} failed to start`)
  }
  let released = false
  const exitListeners = new Set<() => void>()
  child.once('exit', () => {
    if (released) return
    for (const listener of exitListeners) listener()
  })
  return {
    pid: child.pid,
    command,
    args,
    onUnexpectedExit(listener) {
      exitListeners.add(listener)
      return () => { exitListeners.delete(listener) }
    },
    async release() {
      if (released) return
      released = true
      if (options.closeStdin) {
        try { child.stdin?.end() } catch { /* already closed */ }
      }
      await stopChild(child)
    },
  }
}

function waitForStart(child: ChildProcess): Promise<{ ok: boolean }> {
  if (child.killed || child.exitCode !== null) return Promise.resolve({ ok: false })
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      child.off('spawn', onSpawn)
      child.off('error', onFail)
      child.off('exit', onFail)
      resolve({ ok })
    }
    const onSpawn = () => done(true)
    const onFail = () => done(false)
    child.once('spawn', onSpawn)
    child.once('error', onFail)
    child.once('exit', onFail)
  })
}

function stopChild(child: ChildProcess): Promise<void> {
  if (child.killed || child.exitCode !== null) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* already gone */ }
    }, 500)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
    try { child.kill('SIGTERM') } catch {
      clearTimeout(timer)
      resolve()
    }
  })
}
