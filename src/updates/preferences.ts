import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { themePreferencePath } from '../ui/theme-manager.ts'
import type { UpdateChannel } from './feed.ts'

// The update channel lives in the same preferences.json as the theme, so reads and writes merge rather than replace.
export function readUpdateChannel(path: string | false = themePreferencePath()): UpdateChannel | undefined {
  if (!path) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { updateChannel?: unknown }
    return value.updateChannel === 'stable' || value.updateChannel === 'prerelease' ? value.updateChannel : undefined
  } catch {
    return undefined
  }
}

export function writeUpdateChannel(channel: UpdateChannel, path: string | false = themePreferencePath()): void {
  if (!path) return
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    existing = {}
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...existing, updateChannel: channel }, null, 2)}\n`, 'utf8')
}
