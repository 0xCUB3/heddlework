import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ThemeManager, detectSystemTheme, themePreferencePath, resolveInterfaceFonts } from '../src/ui/theme-manager.ts'
import { applyResolvedTheme, DEFAULT_INTERFACE_FONTS, colors, darkColors, lightColors, nativeTheme } from '../src/ui/theme.ts'

const temporaryDirectories: string[] = []

afterEach(() => {
  applyResolvedTheme('dark')
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('ThemeManager', () => {
  it('applies and persists explicit theme modes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-theme-'))
    temporaryDirectories.push(directory)
    const preferencePath = join(directory, 'preferences.json')
    const manager = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'dark' })

    manager.setMode('light')

    expect(manager.getSnapshot()).toEqual({ fonts: DEFAULT_INTERFACE_FONTS, mode: 'light', resolved: 'light' })
    expect(colors.background).toBe(lightColors.background)
    expect(nativeTheme.appearance).toBe('light')
    expect(JSON.parse(readFileSync(preferencePath, 'utf8'))).toEqual({ themeMode: 'light' })

    const restored = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'dark' })
    expect(restored.getSnapshot()).toEqual({ fonts: DEFAULT_INTERFACE_FONTS, mode: 'light', resolved: 'light' })
    manager.dispose()
    restored.dispose()
  })

  it('merges themeMode into existing preferences', () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-theme-merge-'))
    temporaryDirectories.push(directory)
    const preferencePath = join(directory, 'preferences.json')
    writeFileSync(preferencePath, JSON.stringify({ remoteAccess: 'local', tailscaleServe: { enabled: true } }, null, 2))
    const manager = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'dark' })
    manager.setMode('light')
    expect(JSON.parse(readFileSync(preferencePath, 'utf8'))).toEqual({ remoteAccess: 'local', tailscaleServe: { enabled: true }, themeMode: 'light' })
    manager.dispose()
  })

  it('tracks system appearance changes only in system mode', () => {
    let systemTheme: 'light' | 'dark' = 'dark'
    const manager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => systemTheme })
    let notifications = 0
    manager.subscribe(() => { notifications += 1 })

    systemTheme = 'light'
    manager.refreshSystemTheme()
    expect(manager.getSnapshot()).toEqual({ fonts: DEFAULT_INTERFACE_FONTS, mode: 'system', resolved: 'light' })
    expect(colors.background).toBe(lightColors.background)
    expect(notifications).toBe(1)

    manager.setMode('dark')
    systemTheme = 'light'
    manager.refreshSystemTheme()
    expect(manager.getSnapshot()).toEqual({ fonts: DEFAULT_INTERFACE_FONTS, mode: 'dark', resolved: 'dark' })
    expect(colors.background).toBe(darkColors.background)
    manager.dispose()
  })
})

describe('interface fonts', () => {
  it('persists independent choices, survives theme changes, and resets only fonts', () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-fonts-'))
    temporaryDirectories.push(directory)
    const preferencePath = join(directory, 'preferences.json')
    writeFileSync(preferencePath, JSON.stringify({ remoteAccess: 'local', themeMode: 'system' }))
    let systemTheme: 'light' | 'dark' = 'dark'
    const manager = new ThemeManager({ preferencePath, resolveSystemTheme: () => systemTheme })
    let notifications = 0
    manager.subscribe(() => { notifications += 1 })
    const original = manager.getSnapshot()
    const family = 'ComicShannsMono Nerd Font Mono'
    manager.setFonts({ fontSans: `  ${family}  ` })
    expect(manager.getSnapshot()).not.toBe(original)
    expect(manager.getSnapshot().fonts).toEqual({ fontSans: family, fontMono: DEFAULT_INTERFACE_FONTS.fontMono })
    expect(nativeTheme.fontSans).toBe(family)
    manager.setFonts({ fontMono: family })
    const snapshot = manager.getSnapshot()
    manager.setFonts({ fontMono: family })
    expect(manager.getSnapshot()).toBe(snapshot)
    expect(notifications).toBe(2)
    systemTheme = 'light'
    manager.refreshSystemTheme()
    manager.setMode('dark')
    expect(nativeTheme.fontSans).toBe(family)
    expect(nativeTheme.fontMono).toBe(family)
    const restored = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'light' })
    expect(restored.getSnapshot()).toEqual(manager.getSnapshot())
    restored.resetFonts()
    expect(restored.getSnapshot().fonts).toEqual(DEFAULT_INTERFACE_FONTS)
    expect(restored.getSnapshot().mode).toBe('dark')
    expect(JSON.parse(readFileSync(preferencePath, 'utf8'))).toEqual({
      remoteAccess: 'local', themeMode: 'dark', interfaceFonts: DEFAULT_INTERFACE_FONTS,
    })
    manager.dispose()
    restored.dispose()
  })

  it('normalizes families and safely loads malformed preferences', () => {
    expect(resolveInterfaceFonts({ fontSans: '  ComicShannsMono\n Nerd Font Mono ', fontMono: 42 })).toEqual({
      fontSans: 'ComicShannsMono Nerd Font Mono', fontMono: DEFAULT_INTERFACE_FONTS.fontMono,
    })
    for (const value of [null, [], false, { fontSans: ' ', fontMono: null }]) {
      expect(resolveInterfaceFonts(value)).toEqual(DEFAULT_INTERFACE_FONTS)
    }
    expect(resolveInterfaceFonts({ fontMono: 'a'.repeat(200) }).fontMono).toHaveLength(160)
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-fonts-invalid-'))
    temporaryDirectories.push(directory)
    const preferencePath = join(directory, 'preferences.json')
    for (const value of ['{broken', 'null', '{"interfaceFonts":{"fontSans":7}}']) {
      writeFileSync(preferencePath, value)
      const manager = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'dark' })
      expect(manager.getSnapshot().fonts).toEqual(DEFAULT_INTERFACE_FONTS)
      manager.dispose()
    }
    const manager = new ThemeManager({ preferencePath: directory, resolveSystemTheme: () => 'dark' })
    manager.setFonts({ fontSans: 'ComicShannsMono Nerd Font Mono' })
    expect(nativeTheme.fontSans).toBe('ComicShannsMono Nerd Font Mono')
    manager.dispose()
  })
})

describe('system theme detection', () => {
  it('reads macOS, Windows, and Linux appearance values', () => {
    expect(detectSystemTheme('darwin', () => 'Dark')).toBe('dark')
    expect(detectSystemTheme('darwin', () => undefined)).toBe('light')
    expect(detectSystemTheme('win32', () => '0')).toBe('dark')
    expect(detectSystemTheme('win32', () => '1')).toBe('light')
    expect(detectSystemTheme('linux', (_command, args) => args.at(-1) === 'color-scheme' ? "'prefer-dark'" : undefined)).toBe('dark')
  })

  it('uses platform-appropriate preference locations', () => {
    expect(themePreferencePath('darwin', {}, '/home/test')).toBe('/home/test/Library/Application Support/Heddlework/preferences.json')
    expect(themePreferencePath('linux', { XDG_CONFIG_HOME: '/config' }, '/home/test')).toBe('/config/heddlework/preferences.json')
    expect(themePreferencePath('win32', { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' }, 'C:\\Users\\test')).toContain('Heddlework')
  })
})
