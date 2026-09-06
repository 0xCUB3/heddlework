// Browser ThemeManager: same shape as src/ui/theme-manager.ts, backed by localStorage and prefers-color-scheme.

import { applyResolvedTheme, DEFAULT_INTERFACE_FONTS, type InterfaceFonts, type ResolvedTheme } from '../../ui/theme.ts'

export type ThemeMode = 'system' | ResolvedTheme

export interface ThemeSnapshot {
  mode: ThemeMode
  resolved: ResolvedTheme
  fonts: InterfaceFonts
}

const MODE_KEY = 'heddlework.theme'
const FONTS_KEY = 'heddlework.fonts'

function systemTheme(): ResolvedTheme {
  return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
}

function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(MODE_KEY)
    return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
  } catch {
    return 'system'
  }
}

export function resolveInterfaceFonts(value: unknown): InterfaceFonts {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const family = (key: keyof InterfaceFonts) => {
    const raw = input[key]
    return typeof raw === 'string' ? raw.trim().replace(/\s+/gu, ' ').slice(0, 160) || DEFAULT_INTERFACE_FONTS[key] : DEFAULT_INTERFACE_FONTS[key]
  }
  return { fontSans: family('fontSans'), fontMono: family('fontMono') }
}

function readFonts(): InterfaceFonts {
  try {
    return resolveInterfaceFonts(JSON.parse(localStorage.getItem(FONTS_KEY) ?? '{}'))
  } catch {
    return DEFAULT_INTERFACE_FONTS
  }
}

export class ThemeManager {
  readonly #listeners = new Set<() => void>()
  #snapshot: ThemeSnapshot
  #media: MediaQueryList | undefined

  constructor() {
    const mode = readMode()
    this.#snapshot = { mode, resolved: mode === 'system' ? systemTheme() : mode, fonts: readFonts() }
    applyResolvedTheme(this.#snapshot.resolved, this.#snapshot.fonts)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): ThemeSnapshot => this.#snapshot

  setMode(mode: ThemeMode): void {
    const resolved = mode === 'system' ? systemTheme() : mode
    this.#snapshot = { ...this.#snapshot, mode, resolved }
    applyResolvedTheme(resolved, this.#snapshot.fonts)
    try { localStorage.setItem(MODE_KEY, mode) } catch { /* private mode */ }
    this.#emit()
  }

  setFonts(patch: Partial<InterfaceFonts>): void {
    const fonts = resolveInterfaceFonts({ ...this.#snapshot.fonts, ...patch })
    this.#snapshot = { ...this.#snapshot, fonts }
    applyResolvedTheme(this.#snapshot.resolved, fonts)
    try { localStorage.setItem(FONTS_KEY, JSON.stringify(fonts)) } catch { /* private mode */ }
    this.#emit()
  }

  resetFonts(): void { this.setFonts(DEFAULT_INTERFACE_FONTS) }

  start(): void {
    if (this.#media || typeof matchMedia !== 'function') return
    this.#media = matchMedia('(prefers-color-scheme: light)')
    this.#media.addEventListener('change', () => this.refreshSystemTheme())
  }

  refreshSystemTheme(): void {
    if (this.#snapshot.mode !== 'system') return
    const resolved = systemTheme()
    if (resolved === this.#snapshot.resolved) return
    this.#snapshot = { ...this.#snapshot, resolved }
    applyResolvedTheme(resolved, this.#snapshot.fonts)
    this.#emit()
  }

  dispose(): void { this.#listeners.clear() }

  #emit(): void { for (const listener of this.#listeners) listener() }
}

export function detectSystemTheme(): ResolvedTheme { return systemTheme() }
export function themePreferencePath(): string { return '' }
export const defaultThemeManager = new ThemeManager()
