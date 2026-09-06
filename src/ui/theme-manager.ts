import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { applyResolvedTheme, DEFAULT_INTERFACE_FONTS, type InterfaceFonts, type ResolvedTheme } from './theme.ts'

export type ThemeMode = 'system' | ResolvedTheme

export interface ThemeSnapshot {
  mode: ThemeMode
  resolved: ResolvedTheme
  fonts: InterfaceFonts
}

interface ThemeManagerOptions {
  preferencePath?: string | false
  resolveSystemTheme?: () => ResolvedTheme
  pollIntervalMs?: number
}

export class ThemeManager {
  readonly #listeners = new Set<() => void>()
  readonly #preferencePath: string | false
  readonly #resolveSystemTheme: () => ResolvedTheme
  readonly #pollIntervalMs: number
  #snapshot: ThemeSnapshot
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(options: ThemeManagerOptions = {}) {
    this.#preferencePath = options.preferencePath === undefined ? themePreferencePath() : options.preferencePath
    this.#resolveSystemTheme = options.resolveSystemTheme ?? detectSystemTheme
    this.#pollIntervalMs = options.pollIntervalMs ?? 2_000
    const mode = readThemeMode(this.#preferencePath) ?? 'system'
    this.#snapshot = { mode, resolved: mode === 'system' ? this.#resolveSystemTheme() : mode, fonts: readInterfaceFonts(this.#preferencePath) }
    applyResolvedTheme(this.#snapshot.resolved, this.#snapshot.fonts)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): ThemeSnapshot => this.#snapshot

  setMode(mode: ThemeMode): void {
    const resolved = mode === 'system' ? this.#resolveSystemTheme() : mode
    if (mode === this.#snapshot.mode && resolved === this.#snapshot.resolved) return
    this.#snapshot = { ...this.#snapshot, mode, resolved }
    applyResolvedTheme(resolved, this.#snapshot.fonts)
    writePreferences(this.#preferencePath, { themeMode: mode })
    this.#emit()
  }

  setFonts(patch: Partial<InterfaceFonts>): void {
    const fonts = resolveInterfaceFonts({ ...this.#snapshot.fonts, ...patch })
    if (fonts.fontSans === this.#snapshot.fonts.fontSans && fonts.fontMono === this.#snapshot.fonts.fontMono) return
    this.#snapshot = { ...this.#snapshot, fonts }
    applyResolvedTheme(this.#snapshot.resolved, fonts)
    writePreferences(this.#preferencePath, { interfaceFonts: fonts })
    this.#emit()
  }

  resetFonts(): void {
    this.setFonts(DEFAULT_INTERFACE_FONTS)
  }

  start(): void {
    if (this.#timer) return
    this.#timer = setInterval(() => this.refreshSystemTheme(), this.#pollIntervalMs)
    this.#timer.unref?.()
  }

  refreshSystemTheme(): void {
    if (this.#snapshot.mode !== 'system') return
    const resolved = this.#resolveSystemTheme()
    if (resolved === this.#snapshot.resolved) return
    this.#snapshot = { ...this.#snapshot, resolved }
    applyResolvedTheme(resolved, this.#snapshot.fonts)
    this.#emit()
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = undefined
    this.#listeners.clear()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

export function detectSystemTheme(platform: NodeJS.Platform = process.platform, run: (command: string, args: string[]) => string | undefined = runCommand): ResolvedTheme {
  if (platform === 'darwin') {
    const value = run('defaults', ['read', '-g', 'AppleInterfaceStyle'])
    return value?.trim().toLowerCase() === 'dark' ? 'dark' : 'light'
  }
  if (platform === 'win32') {
    const value = run('powershell.exe', ['-NoProfile', '-Command', '(Get-ItemProperty -Path HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize).AppsUseLightTheme'])
    return value?.trim() === '0' ? 'dark' : 'light'
  }
  if (platform === 'linux') {
    const scheme = run('gsettings', ['get', 'org.gnome.desktop.interface', 'color-scheme'])?.toLowerCase()
    if (scheme?.includes('dark')) return 'dark'
    if (scheme?.includes('light')) return 'light'
    const gtkTheme = run('gsettings', ['get', 'org.gnome.desktop.interface', 'gtk-theme'])?.toLowerCase()
    if (gtkTheme) return gtkTheme.includes('dark') ? 'dark' : 'light'
    if (scheme?.includes('default')) return 'light'
  }
  return 'dark'
}

export function themePreferencePath(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'preferences.json')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'preferences.json')
  return join(environment.XDG_CONFIG_HOME ?? join(home, '.config'), 'heddlework', 'preferences.json')
}

function runCommand(command: string, args: string[]): string | undefined {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 750 })
  } catch {
    return undefined
  }
}

function readThemeMode(path: string | false): ThemeMode | undefined {
  if (!path) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { themeMode?: unknown }
    return value.themeMode === 'system' || value.themeMode === 'light' || value.themeMode === 'dark' ? value.themeMode : undefined
  } catch {
    return undefined
  }
}

export function resolveInterfaceFonts(value: unknown): InterfaceFonts {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const family = (key: keyof InterfaceFonts) => {
    const raw = input[key]
    return typeof raw === 'string'
      ? raw.trim().replace(/\s+/gu, ' ').slice(0, 160) || DEFAULT_INTERFACE_FONTS[key]
      : DEFAULT_INTERFACE_FONTS[key]
  }
  return { fontSans: family('fontSans'), fontMono: family('fontMono') }
}

function readInterfaceFonts(path: string | false): InterfaceFonts {
  if (path) {
    try {
      return resolveInterfaceFonts(JSON.parse(readFileSync(path, 'utf8'))?.interfaceFonts)
    } catch {
      // Invalid or missing preferences use the shipped font families.
    }
  }
  return DEFAULT_INTERFACE_FONTS
}

function writePreferences(path: string | false, patch: Record<string, unknown>): void {
  if (!path) return
  try {
    let existing: Record<string, unknown> = {}
    try {
      existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    } catch {
      existing = {}
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify({ ...existing, ...patch }, null, 2)}\n`, 'utf8')
  } catch {
    // Theme changes still apply for this run when the preference cannot be persisted.
  }
}

export const defaultThemeManager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
