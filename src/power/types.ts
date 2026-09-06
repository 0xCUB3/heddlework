export const SLEEP_PREVENTION_WHEN = ['off', 'whileWorking', 'whileAppOpen'] as const

export type SleepPreventionWhen = (typeof SLEEP_PREVENTION_WHEN)[number]

export interface SleepPreventionPolicy {
  when: SleepPreventionWhen
  keepDisplayAwake: boolean
}

export type SleepPreventionStatus = 'idle' | 'active' | 'unsupported' | 'error'

export type SleepPreventionBackendName = 'caffeinate' | 'execution-state' | 'systemd-inhibit' | 'none'

export type SleepPreventionPlatform = 'darwin' | 'win32' | 'linux' | 'other'

export interface SleepPreventionSnapshot {
  policy: SleepPreventionPolicy
  status: SleepPreventionStatus
  inhibiting: boolean
  displaySupported: boolean
  platform: SleepPreventionPlatform
  backend: SleepPreventionBackendName
  reason: string
  limits: string
  error?: string | undefined
}

export const DEFAULT_SLEEP_PREVENTION_POLICY: SleepPreventionPolicy = {
  when: 'whileWorking',
  keepDisplayAwake: false,
}

export const SLEEP_INHIBIT_WHO = 'Heddlework'
export const SLEEP_INHIBIT_WHY = 'Heddlework is running'

export function isSleepPreventionWhen(value: unknown): value is SleepPreventionWhen {
  return value === 'off' || value === 'whileWorking' || value === 'whileAppOpen'
}

export function parseSleepPreventionPolicy(value: unknown): SleepPreventionPolicy {
  if (!value || typeof value !== 'object') return { ...DEFAULT_SLEEP_PREVENTION_POLICY }
  const record = value as { when?: unknown; keepDisplayAwake?: unknown }
  return {
    when: isSleepPreventionWhen(record.when) ? record.when : DEFAULT_SLEEP_PREVENTION_POLICY.when,
    keepDisplayAwake: typeof record.keepDisplayAwake === 'boolean' ? record.keepDisplayAwake : DEFAULT_SLEEP_PREVENTION_POLICY.keepDisplayAwake,
  }
}

export function sleepPreventionPlatform(platform: string): SleepPreventionPlatform {
  if (platform === 'darwin' || platform === 'win32' || platform === 'linux') return platform
  return 'other'
}
