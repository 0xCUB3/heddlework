import { afterEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mayAutomateBrowser } from '../src/browser/adapter.ts'
import { BrowserSessionService } from '../src/browser/service.ts'
import { browserDataRoot, browserProfilesRoot, browserStatePath } from '../src/browser/persistence.ts'
import { browserDisplayAddress, isBrowserUrlAllowed, resolveBrowserAddress } from '../src/browser/url.ts'

const directories: string[] = []

afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

function serviceHarness() {
  const root = mkdtempSync(join(tmpdir(), 'heddlework-browser-'))
  directories.push(root)
  const statePath = join(root, 'browser.json')
  const dataRoot = join(root, 'data')
  return { root, statePath, dataRoot, service: new BrowserSessionService({ statePath, dataRoot }) }
}

describe('browser addresses', () => {
  it('distinguishes local apps, hosts, searches, and unsafe schemes', () => {
    expect(resolveBrowserAddress('localhost:5173/app')).toBe('http://localhost:5173/app')
    expect(resolveBrowserAddress('example.com/docs')).toBe('https://example.com/docs')
    expect(resolveBrowserAddress('native browser profiles')).toBe('https://www.google.com/search?q=native%20browser%20profiles')
    expect(resolveBrowserAddress('file:///etc/passwd')).toBeUndefined()
    expect(resolveBrowserAddress('javascript:alert(1)')).toBeUndefined()
    expect(resolveBrowserAddress('about:blank')).toBe('about:blank')
    expect(resolveBrowserAddress('about:config')).toBeUndefined()
    expect(isBrowserUrlAllowed('https://example.com')).toBe(true)
    expect(isBrowserUrlAllowed('about:blank')).toBe(true)
    expect(isBrowserUrlAllowed('about:config')).toBe(false)
    expect(isBrowserUrlAllowed('file:///tmp/private')).toBe(false)
    expect(browserDisplayAddress('https://example.com/path?q=1')).toBe('example.com/path?q=1')
  })
})

describe('browser sessions', () => {
  it('manages tabs, navigation state, commands, and popup requests', () => {
    const { service } = serviceHarness()
    const first = service.ensureTab()
    expect(service.getSnapshot().tabs).toHaveLength(1)
    expect(service.navigate(first, 'localhost:3000')).toBe(true)
    expect(service.getSnapshot().tabs[0]).toMatchObject({
      id: first,
      url: 'http://localhost:3000/',
      status: 'loading',
      materialized: true,
      commandSerial: 2,
      commands: [
        { kind: 'navigate', serial: 1, value: 'http://localhost:3000/' },
        { kind: 'focus', serial: 2 },
      ],
    })

    const generation = service.getSnapshot().tabs[0]!.generation
    service.applyNativeState(first, {
      generation,
      url: 'http://localhost:3000/dashboard',
      title: 'Dashboard',
      loading: false,
      canGoBack: true,
      canGoForward: false,
      commandSerial: 2,
    })
    expect(service.getSnapshot().tabs[0]).toMatchObject({ title: 'Dashboard', status: 'ready', canGoBack: true })

    service.applyNativeState(first, { generation, loading: false, error: 'Navigation failed' })
    service.applyNativeState(first, { generation, title: 'Failed dashboard', loading: false })
    expect(service.getSnapshot().tabs[0]).toMatchObject({ title: 'Failed dashboard', status: 'error', error: 'Navigation failed' })

    service.command(first, 'back')
    expect(service.getSnapshot().tabs[0]?.commands).toEqual([
      { kind: 'back', serial: 3 },
      { kind: 'focus', serial: 4 },
    ])
    expect(service.getSnapshot().tabs[0]?.error).toBeUndefined()
    service.applyNativeState(first, { generation, commandSerial: 4 })
    service.command(first, 'clearData')
    service.command(first, 'reload')
    expect(service.getSnapshot().tabs[0]?.commands).toEqual([
      { kind: 'clearData', serial: 5 },
      { kind: 'reload', serial: 6 },
      { kind: 'focus', serial: 7 },
    ])
    service.applyNativeState(first, { generation, commandSerial: 6 })
    expect(service.getSnapshot().tabs[0]?.commands).toEqual([{ kind: 'focus', serial: 7 }])
    const popup = service.openRequested(first, generation, 'https://example.com/login')
    expect(popup).toBeDefined()
    expect(service.getSnapshot()).toMatchObject({ activeTabId: popup })
    expect(service.getSnapshot().tabs.find((tab) => tab.id === popup)).toMatchObject({ profileId: 'workspace' })
  })

  it('rejects native events from an earlier profile generation', () => {
    const { service } = serviceHarness()
    const tabId = service.createTab({ profileId: 'workspace', address: 'https://example.com' })
    const oldGeneration = service.getSnapshot().tabs[0]!.generation

    service.switchTabProfile(tabId, 'personal')
    const switched = service.getSnapshot().tabs[0]!
    expect(switched).toMatchObject({ profileId: 'personal', generation: oldGeneration + 1 })

    service.applyNativeState(tabId, { generation: oldGeneration, title: 'stale', loading: false, commandSerial: 99 })
    expect(service.openRequested(tabId, oldGeneration, 'https://stale.example')).toBeUndefined()
    expect(service.getSnapshot().tabs).toHaveLength(1)
    expect(service.getSnapshot().tabs[0]).toMatchObject({ title: 'Loading…', status: 'loading' })

    service.applyNativeState(tabId, { generation: switched.generation, title: 'current', loading: false })
    expect(service.getSnapshot().tabs[0]).toMatchObject({ title: 'current', status: 'ready' })
    service.dispose()
  })

  it('does not reuse generations when the service is recreated during hot reload', () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-browser-reload-'))
    directories.push(root)
    const statePath = join(root, 'browser.json')
    const dataRoot = join(root, 'data')
    const first = new BrowserSessionService({ statePath, dataRoot })
    const tabId = first.createTab({ address: 'https://example.com' })
    const oldGeneration = first.getSnapshot().tabs[0]!.generation
    first.dispose()
    expect(first.openRequested(tabId, oldGeneration, 'https://stale.example')).toBeUndefined()
    expect(() => first.applyNativeState(tabId, { generation: oldGeneration, title: 'stale' })).not.toThrow()

    const replacement = new BrowserSessionService({ statePath, dataRoot })
    const restored = replacement.getSnapshot().tabs.find((tab) => tab.id === tabId)!
    expect(restored.generation).toBeGreaterThan(oldGeneration)
    replacement.applyNativeState(tabId, { generation: oldGeneration, title: 'stale' })
    expect(replacement.getSnapshot().tabs.find((tab) => tab.id === tabId)?.title).not.toBe('stale')
    replacement.dispose()
  })

  it('skips malformed persisted records instead of crashing startup', () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-browser-corrupt-'))
    directories.push(root)
    const statePath = join(root, 'browser.json')
    writeFileSync(statePath, JSON.stringify({
      version: 1,
      profiles: [null, { id: 4 }, { id: 'profile-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Recovered', kind: 'workspace', persistent: true, agentAccess: 'prompt', builtIn: false }],
      defaultProfileId: 'workspace',
      tabs: [null, {}, { id: 'valid', profileId: 'workspace', url: 'https://example.com', title: 'Valid', createdAt: 1, lastActiveAt: 2 }],
      activeTabId: 'valid',
    }))

    const service = new BrowserSessionService({ statePath, dataRoot: join(root, 'data') })
    expect(service.getSnapshot().tabs.map((tab) => tab.id)).toEqual(['valid'])
    expect(service.getSnapshot().profiles.some((profile) => profile.name === 'Recovered')).toBe(true)
    service.dispose()
  })

  it('serializes real processes that address one profile root through symlink aliases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-browser-alias-lock-'))
    directories.push(root)
    const dataRoot = join(root, 'data')
    const aliasRoot = join(root, 'data-alias')
    const releasePath = join(root, 'release')
    mkdirSync(dataRoot)
    symlinkSync(dataRoot, aliasRoot)
    const persistenceModule = new URL('../src/browser/persistence.ts', import.meta.url).href
    const ownerSource = `
      import { existsSync } from 'node:fs'
      import { claimBrowserDataRoot } from ${JSON.stringify(persistenceModule)}
      const claim = claimBrowserDataRoot(${JSON.stringify(dataRoot)})
      console.log(JSON.stringify(claim))
      while (!existsSync(${JSON.stringify(releasePath)})) await Bun.sleep(10)
    `
    const owner = Bun.spawn([process.execPath, '-e', ownerSource], { stdout: 'pipe', stderr: 'pipe' })
    const reader = owner.stdout.getReader()
    const announcement = await reader.read()
    expect(JSON.parse(new TextDecoder().decode(announcement.value))).toMatchObject({ acquired: true })

    const contenderSource = `
      import { claimBrowserDataRoot } from ${JSON.stringify(persistenceModule)}
      console.log(JSON.stringify(claimBrowserDataRoot(${JSON.stringify(aliasRoot)})))
    `
    const contender = Bun.spawn([process.execPath, '-e', contenderSource], { stdout: 'pipe', stderr: 'pipe' })
    const contenderOutput = await new Response(contender.stdout).text()
    expect(await contender.exited).toBe(0)
    expect(JSON.parse(contenderOutput)).toMatchObject({ acquired: false })

    writeFileSync(releasePath, '')
    reader.releaseLock()
    expect(await owner.exited).toBe(0)
  })

  it('fails closed without reading or writing when another process owns the profile root', () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-browser-locked-'))
    directories.push(root)
    const statePath = join(root, 'browser.json')
    const dataRoot = join(root, 'data')
    const persisted = JSON.stringify({
      version: 1,
      profiles: [{ id: 'profile-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'Must not load', kind: 'workspace', persistent: true, agentAccess: 'allowed', builtIn: false }],
      defaultProfileId: 'workspace',
      tabs: [],
    })
    writeFileSync(statePath, persisted)
    writeFileSync(`${dataRoot}.lock`, '1\n')

    const service = new BrowserSessionService({ statePath, dataRoot })
    service.setEngine({ kind: 'cef', available: true, message: 'Chromium', profileIsolation: 'full' })
    expect(service.canInitializeNativeBrowser()).toBe(false)
    expect(service.runtimeProfile('workspace')).toBeUndefined()
    expect(service.getSnapshot().engine).toMatchObject({ kind: 'unavailable', available: false })
    expect(service.getSnapshot().profiles.some((profile) => profile.name === 'Must not load')).toBe(false)
    service.createTab({ address: 'https://example.com' })
    service.dispose()
    expect(readFileSync(statePath, 'utf8')).toBe(persisted)
    expect(existsSync(`${statePath}.lock`)).toBe(false)
  })

  it('isolates profile paths and never restores private tabs', () => {
    const { statePath, dataRoot, service } = serviceHarness()
    const workspaceTab = service.createTab({ profileId: 'workspace', address: 'https://example.com' })
    const privateTab = service.createTab({ profileId: 'private', address: 'https://secret.example' })
    expect(service.runtimeProfile('workspace')).toEqual({
      id: 'workspace',
      path: join(realpathSync(dataRoot), 'profiles', 'workspace'),
      incognito: false,
      agentAccess: 'allowed',
    })
    expect(service.runtimeProfile('private')).toEqual({
      id: 'private',
      path: '',
      incognito: true,
      agentAccess: 'denied',
    })

    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { tabs: Array<{ id: string }> }
    expect(persisted.tabs.map((tab) => tab.id)).toEqual([workspaceTab])
    expect(persisted.tabs.some((tab) => tab.id === privateTab)).toBe(false)

    const restored = new BrowserSessionService({ statePath, dataRoot })
    expect(restored.getSnapshot().tabs.map((tab) => tab.id)).toEqual([workspaceTab])
    expect(restored.getSnapshot().tabs[0]?.materialized).toBe(false)
    expect(restored.ensureTab()).toBe(workspaceTab)
    expect(restored.getSnapshot().tabs[0]?.materialized).toBe(true)
    restored.dispose()
  })

  it('creates app-owned profiles with explicit agent policy and removes orphaned data', () => {
    const { statePath, dataRoot, service } = serviceHarness()
    const tab = service.ensureTab()
    const profile = service.createProfile({ name: '  Preview  ', agentAccess: 'prompt' })
    service.switchTabProfile(tab, profile)
    service.setDefaultProfile(profile)
    expect(service.getSnapshot().profiles.find((candidate) => candidate.id === profile)).toMatchObject({
      name: 'Preview',
      persistent: true,
      agentAccess: 'prompt',
      builtIn: false,
    })
    expect(service.getSnapshot()).toMatchObject({ defaultProfileId: profile })
    expect(service.getSnapshot().tabs[0]).toMatchObject({ profileId: profile })
    const profilePath = join(dataRoot, 'profiles', profile)
    mkdirSync(profilePath, { recursive: true })
    expect(service.removeProfile(profile)).toBe(true)
    expect(service.getSnapshot().tabs[0]).toMatchObject({ profileId: 'workspace' })
    expect(service.removeProfile('personal')).toBe(false)
    const hotReloaded = new BrowserSessionService({ statePath, dataRoot, cleanupOrphanedProfiles: false })
    expect(existsSync(profilePath)).toBe(true)
    hotReloaded.dispose()
    const coldStarted = new BrowserSessionService({ statePath, dataRoot })
    expect(existsSync(profilePath)).toBe(false)
    coldStarted.dispose()
  })

  it('publishes placement only when native surface geometry changes', () => {
    const { service } = serviceHarness()
    const tab = service.ensureTab()
    let publications = 0
    service.subscribe(() => { publications += 1 })
    const bounds = { x: 10, y: 20, width: 600, height: 400 }
    service.setPlacement(tab, bounds, true)
    service.setPlacement(tab, bounds, true)
    expect(publications).toBe(1)
    expect(service.getSnapshot().placement).toEqual({ tabId: tab, bounds, visible: true })
    service.hidePlacement(tab)
    expect(service.getSnapshot().placement?.visible).toBe(false)
  })
})

describe('browser automation policy', () => {
  it('denies personal profiles and requires a live grant for prompt profiles', () => {
    expect(mayAutomateBrowser({ profileId: 'personal', access: 'denied' })).toBe(false)
    expect(mayAutomateBrowser({ profileId: 'workspace', access: 'allowed' })).toBe(true)
    expect(mayAutomateBrowser({ profileId: 'preview', access: 'prompt' }, 100)).toBe(false)
    expect(mayAutomateBrowser({ profileId: 'preview', access: 'prompt', grantedAt: 50, expiresAt: 150 }, 100)).toBe(true)
    expect(mayAutomateBrowser({ profileId: 'preview', access: 'prompt', grantedAt: 50, expiresAt: 75 }, 100)).toBe(false)
  })
})

describe('browser persistence paths', () => {
  it('uses platform-specific config and data roots', () => {
    expect(browserStatePath('darwin', {}, '/Users/test')).toBe('/Users/test/Library/Application Support/Heddlework/browser.json')
    expect(browserDataRoot('linux', { XDG_DATA_HOME: '/data' }, '/home/test')).toBe('/data/heddlework/browser')
    expect(browserProfilesRoot('linux', { XDG_DATA_HOME: '/data' }, '/home/test')).toBe('/data/heddlework/browser/profiles')
    expect(browserDataRoot('win32', { LOCALAPPDATA: 'C:\\Local' }, 'C:\\Users\\test')).toBe('C:\\Local/Heddlework/Browser')
  })
})
