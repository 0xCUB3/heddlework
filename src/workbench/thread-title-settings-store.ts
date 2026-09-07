import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeThreadTitleSettings, type ThreadTitleSettings } from './thread-titles.ts'

export interface ThreadTitleSettingsStoreService {
  load(): ThreadTitleSettings
  save(settings: ThreadTitleSettings): void
  // Fires after every save so controllers sharing one store stay in step.
  subscribe?(listener: () => void): () => void
}

// Per-machine title preferences. Lives beside threads.json so both travel together.
export class FileThreadTitleSettingsStore implements ThreadTitleSettingsStoreService {
  readonly #path: string | false
  #settings: ThreadTitleSettings | undefined
  readonly #listeners = new Set<() => void>()

  constructor(path: string | false = threadTitleSettingsPath()) {
    this.#path = path
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  load(): ThreadTitleSettings {
    if (this.#settings) return this.#settings
    let raw: unknown
    if (this.#path) {
      try { raw = JSON.parse(readFileSync(this.#path, 'utf8')) } catch { raw = undefined }
    }
    this.#settings = normalizeThreadTitleSettings(raw)
    return this.#settings
  }

  save(settings: ThreadTitleSettings): void {
    this.#settings = normalizeThreadTitleSettings(settings)
    for (const listener of this.#listeners) listener()
    if (!this.#path) return
    try {
      mkdirSync(dirname(this.#path), { recursive: true })
      const temporary = `${this.#path}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ version: 1, ...this.#settings }, null, 2)}\n`, 'utf8')
      renameSync(temporary, this.#path)
    } catch {
      // Preferences stay usable in memory when the disk is unavailable.
    }
  }
}

export function threadTitleSettingsPath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'thread-titles.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'thread-titles.json')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework', 'thread-titles.json')
}
