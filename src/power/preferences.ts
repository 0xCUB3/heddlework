import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { themePreferencePath } from '../ui/theme-manager.ts'
import { parseSleepPreventionPolicy, type SleepPreventionPolicy } from './types.ts'

export function readSleepPreventionPolicy(path: string | false = themePreferencePath()): SleepPreventionPolicy {
  if (!path) return parseSleepPreventionPolicy(undefined)
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { sleepPrevention?: unknown }
    return parseSleepPreventionPolicy(value.sleepPrevention)
  } catch {
    return parseSleepPreventionPolicy(undefined)
  }
}

export function writeSleepPreventionPolicy(policy: SleepPreventionPolicy, path: string | false = themePreferencePath()): void {
  if (!path) return
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    existing = {}
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...existing, sleepPrevention: policy }, null, 2)}\n`, 'utf8')
}
