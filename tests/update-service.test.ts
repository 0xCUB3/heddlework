import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchLatestRelease, isNewerRelease, type ReleaseInfo } from '../src/updates/feed.ts'
import { applyUpdate, detectInstall, detectRuntimeArch, downloadAsset, parseChecksums, pickReleaseAsset, stageUpdate } from '../src/updates/installer.ts'
import { readUpdateChannel, writeUpdateChannel } from '../src/updates/preferences.ts'
import { UpdateService } from '../src/updates/service.ts'
import { updateActionLabel, updateStatusLabel } from '../src/ui/settings-view.tsx'

const scratch: string[] = []
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hw-update-'))
  scratch.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function release(tag: string, extra: Partial<ReleaseInfo> = {}): ReleaseInfo {
  return { version: tag.replace(/^v/, ''), tag, url: `https://example.test/${tag}`, prerelease: tag.includes('-'), notes: '', assets: [], ...extra }
}

function routes(table: Record<string, () => Response | Promise<Response>>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const hit = Object.entries(table).find(([key]) => url.includes(key))
    if (!hit) return new Response('not found', { status: 404 })
    return hit[1]()
  }) as unknown as typeof fetch
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

describe('release feed', () => {
  it('reads releases/latest on stable and the highest semver on prerelease', async () => {
    const stable = await fetchLatestRelease({ repository: 'o/r', channel: 'stable', currentVersion: '0.1.0', fetch: routes({ 'releases/latest': json({ tag_name: 'v0.2.0', html_url: 'u', assets: [{ name: 'a.zip', browser_download_url: 'https://x/a.zip', size: 3 }] }) }) })
    expect(stable?.version).toBe('0.2.0')
    expect(stable?.assets).toEqual([{ name: 'a.zip', url: 'https://x/a.zip', size: 3 }])
    const pre = await fetchLatestRelease({ repository: 'o/r', channel: 'prerelease', currentVersion: '0.1.0', fetch: routes({ 'releases?': json([{ tag_name: 'v0.2.0-rc.1', prerelease: true }, { tag_name: 'v0.3.0-rc.2', prerelease: true }, { tag_name: 'v0.2.0' }, { tag_name: 'v9.0.0', draft: true }]) }) })
    expect(pre?.tag).toBe('v0.3.0-rc.2')
    expect(await fetchLatestRelease({ repository: 'o/r', channel: 'stable', currentVersion: '0.1.0', fetch: routes({}) })).toBeUndefined()
    await expect(fetchLatestRelease({ repository: 'o/r', channel: 'stable', currentVersion: '0.1.0', fetch: routes({ 'releases/latest': () => new Response('', { status: 500 }) }) })).rejects.toThrow('500')
  })

  it('never offers a prerelease on the stable channel', () => {
    expect(isNewerRelease(release('v0.2.0-rc.1'), '0.1.0', 'stable')).toBe(false)
    expect(isNewerRelease(release('v0.2.0-rc.1'), '0.1.0', 'prerelease')).toBe(true)
    expect(isNewerRelease(release('v0.2.0'), '0.2.0', 'stable')).toBe(false)
    expect(isNewerRelease(release('v0.2.0'), '0.2.0-rc.1', 'stable')).toBe(true)
  })
})

describe('install detection', () => {
  it('classifies bundles, package managers, and source runs', () => {
    const none = () => false
    expect(detectInstall({ platform: 'darwin', execPath: '/Applications/Heddlework.app/Contents/MacOS/heddlework', exists: none })).toEqual({ kind: 'macos-app', root: '/Applications/Heddlework.app' })
    const link = '/opt/homebrew/Caskroom/heddlework/0.1.1/Heddlework.app'
    const brew = { exists: (p: string) => p === '/opt/homebrew/Caskroom/heddlework' || p === link, realpath: (p: string) => (p === link ? '/Applications/Heddlework.app' : p), readdir: () => ['0.1.1'] }
    expect(detectInstall({ platform: 'darwin', execPath: '/Applications/Heddlework.app/Contents/MacOS/heddlework', ...brew }).kind).toBe('homebrew')
    expect(detectInstall({ platform: 'darwin', execPath: '/tmp/other/Heddlework.app/Contents/MacOS/heddlework', ...brew }).kind).toBe('macos-app')
    expect(detectInstall({ platform: 'darwin', execPath: '/usr/local/bin/bun', exists: none }).kind).toBe('source')
    expect(detectInstall({ platform: 'win32', execPath: 'C:\\Users\\me\\scoop\\apps\\heddlework\\current\\heddlework.exe', exists: none }).managedCommand).toBe('scoop update heddlework')
    expect(detectInstall({ platform: 'win32', execPath: 'C:\\Apps\\heddlework\\heddlework.exe', exists: none })).toEqual({ kind: 'windows-portable', root: 'C:\\Apps\\heddlework' })
    expect(detectInstall({ platform: 'linux', execPath: '/usr/lib/heddlework/heddlework', exists: (p) => p === '/usr/bin/apt-get' }).managedCommand).toContain('apt')
    expect(detectInstall({ platform: 'linux', execPath: '/home/me/heddlework/heddlework', exists: none })).toEqual({ kind: 'linux-portable', root: '/home/me/heddlework' })
  })

  it('detects Rosetta and picks the native asset', () => {
    const translated = detectRuntimeArch('darwin', 'x64', () => '1\n')
    expect(translated).toEqual({ appArch: 'x64', hostArch: 'arm64', translated: true })
    const assets = [
      { name: 'heddlework-macos-arm64.zip', url: 'a', size: 1 },
      { name: 'heddlework-macos-x64.zip', url: 'b', size: 1 },
      { name: 'heddlework-windows-x64-unsigned.zip', url: 'c', size: 1 },
      { name: 'heddlework-linux-x64.tar.gz', url: 'd', size: 1 },
      { name: 'heddlework-linux-x64.deb', url: 'e', size: 1 },
    ]
    expect(pickReleaseAsset(assets, 'darwin', translated)?.name).toBe('heddlework-macos-arm64.zip')
    expect(pickReleaseAsset(assets, 'darwin', detectRuntimeArch('darwin', 'x64', () => '0'))?.name).toBe('heddlework-macos-x64.zip')
    expect(pickReleaseAsset(assets, 'win32', detectRuntimeArch('win32', 'x64'))?.name).toBe('heddlework-windows-x64-unsigned.zip')
    expect(pickReleaseAsset(assets, 'linux', detectRuntimeArch('linux', 'x64'))?.name).toBe('heddlework-linux-x64.tar.gz')
  })
})

describe('download and checksum', () => {
  it('parses checksums.txt and rejects a tampered download', async () => {
    const body = 'hello update'
    const sha = new Bun.CryptoHasher('sha256').update(body).digest('hex')
    const sums = parseChecksums(`${sha}  heddlework-linux-x64.tar.gz\nzz not a line\n`)
    expect(sums.get('heddlework-linux-x64.tar.gz')).toBe(sha)
    const dir = tmp()
    const fetchImpl = routes({ 'good': () => new Response(body, { headers: { 'content-length': String(body.length) } }) })
    const seen: Array<number | null> = []
    const digest = await downloadAsset({ asset: { name: 'x', url: 'https://h/good', size: 0 }, expectedSha256: sha, destination: join(dir, 'x'), fetch: fetchImpl, onProgress: (p) => seen.push(p) })
    expect(digest).toBe(sha)
    expect(readFileSync(join(dir, 'x'), 'utf8')).toBe(body)
    expect(seen.at(-1)).toBe(100)
    await expect(downloadAsset({ asset: { name: 'x', url: 'https://h/good', size: 0 }, expectedSha256: 'ab'.repeat(32), destination: join(dir, 'y'), fetch: fetchImpl })).rejects.toThrow('checksum')
    expect(existsSync(join(dir, 'y'))).toBe(false)
  })
})

describe('stage and apply on linux', () => {
  it('unpacks a tarball, swaps the binary and web dir, and relaunches', async () => {
    const dir = tmp()
    const src = join(dir, 'src', 'heddlework')
    mkdirSync(join(src, 'web'), { recursive: true })
    writeFileSync(join(src, 'heddlework'), 'new-binary')
    writeFileSync(join(src, 'web', 'index.html'), 'new-web')
    const archive = join(dir, 'heddlework-linux-x64.tar.gz')
    const tar = Bun.spawnSync(['tar', '-C', join(dir, 'src'), '-czf', archive, 'heddlework'])
    expect(tar.exitCode).toBe(0)
    const root = join(dir, 'install')
    mkdirSync(join(root, 'web'), { recursive: true })
    writeFileSync(join(root, 'heddlework'), 'old-binary')
    writeFileSync(join(root, 'web', 'index.html'), 'old-web')
    const location = { kind: 'linux-portable' as const, root }
    const staged = await stageUpdate({ archive, location, workdir: join(dir, 'work'), platform: 'linux' })
    expect(readFileSync(join(staged, 'heddlework'), 'utf8')).toBe('new-binary')
    const spawned: string[][] = []
    let exitCode: number | undefined
    await applyUpdate({ staged, location, platform: 'linux', execPath: join(root, 'heddlework'), args: ['/repo'], spawnDetached: (c, a) => spawned.push([c, ...a]), exit: (code) => { exitCode = code } })
    expect(readFileSync(join(root, 'heddlework'), 'utf8')).toBe('new-binary')
    expect(readFileSync(join(root, 'web', 'index.html'), 'utf8')).toBe('new-web')
    expect(spawned).toEqual([[join(root, 'heddlework'), '/repo']])
    expect(exitCode).toBe(0)
  })

  it('refuses to replace a package-managed install', async () => {
    await expect(applyUpdate({ staged: '/nowhere', location: { kind: 'homebrew', root: '/Applications/Heddlework.app', managedCommand: 'brew upgrade --cask heddlework' }, platform: 'darwin', exit: () => undefined, spawnDetached: () => undefined })).rejects.toThrow('brew upgrade')
  })

  it('writes a Windows helper script that waits for the pid, swaps, and relaunches', async () => {
    const dir = tmp()
    const staged = join(dir, 'staged')
    mkdirSync(staged, { recursive: true })
    const spawned: string[][] = []
    await applyUpdate({ staged, location: { kind: 'windows-portable', root: 'C:\\Apps\\hw' }, platform: 'win32', args: ['C:\\repo'], pid: 4242, spawnDetached: (c, a) => spawned.push([c, ...a]), exit: () => undefined })
    expect(spawned[0]?.[0]).toBe('cmd.exe')
    const script = readFileSync(spawned[0]![2]!, 'utf8')
    expect(script).toContain('PID eq 4242')
    expect(script).toContain('move /y')
    expect(script).toContain('start "" "C:\\Apps\\hw\\heddlework.exe" "C:\\repo"')
  })
})

describe('update channel preference', () => {
  it('merges with the theme preference file', () => {
    const path = join(tmp(), 'preferences.json')
    writeFileSync(path, JSON.stringify({ themeMode: 'dark' }))
    writeUpdateChannel('prerelease', path)
    expect(readUpdateChannel(path)).toBe('prerelease')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ themeMode: 'dark', updateChannel: 'prerelease' })
    expect(readUpdateChannel(join(tmp(), 'missing.json'))).toBeUndefined()
  })
})

describe('update service', () => {
  const linuxInstall = { kind: 'linux-portable' as const, root: '/opt/hw' }
  const arch = { appArch: 'x64' as const, hostArch: 'x64' as const, translated: false }

  function feedWith(tag: string, assetBody = 'payload') {
    const sha = new Bun.CryptoHasher('sha256').update(assetBody).digest('hex')
    return routes({
      'releases/latest': json({ tag_name: tag, html_url: 'https://r', body: 'notes', assets: [
        { name: 'heddlework-linux-x64.tar.gz', browser_download_url: 'https://dl/heddlework-linux-x64.tar.gz', size: assetBody.length },
        { name: 'checksums.txt', browser_download_url: 'https://dl/checksums.txt', size: 1 },
      ] }),
      'dl/checksums.txt': () => new Response(`${sha}  heddlework-linux-x64.tar.gz\n`),
      'dl/heddlework-linux-x64.tar.gz': () => new Response(assetBody),
    })
  }

  it('goes idle → checking → available → downloading → downloaded, then installs', async () => {
    const dir = tmp()
    const statuses: string[] = []
    const applied: string[] = []
    const service = new UpdateService({
      currentVersion: '0.1.0', repository: 'o/r', install: linuxInstall, arch, platform: 'linux', workdir: dir, fetch: feedWith('v0.2.0'),
      run: async (_command, args) => {
        const target = args[args.length - 1]!
        mkdirSync(join(target, 'heddlework'), { recursive: true })
        writeFileSync(join(target, 'heddlework', 'heddlework'), 'bin')
        return { code: 0, stdout: '', stderr: '' }
      },
      apply: async (options) => { applied.push(options.staged) },
      now: () => '2026-01-01T00:00:00.000Z',
    })
    service.subscribe(() => statuses.push(service.getSnapshot().status))
    expect(service.getSnapshot().status).toBe('idle')
    expect(await service.check('test')).toBe(true)
    const state = service.getSnapshot()
    expect(state.status).toBe('downloaded')
    expect(state.availableVersion).toBe('0.2.0')
    expect(state.downloadedVersion).toBe('0.2.0')
    expect(state.releaseUrl).toBe('https://r')
    expect(state.checkedAt).toBe('2026-01-01T00:00:00.000Z')
    expect(statuses).toEqual(['checking', 'available', 'downloading', 'downloading', 'downloaded'])
    expect(updateActionLabel(state)).toBe('Restart to update')
    expect(updateStatusLabel(state)).toContain('0.2.0 is downloaded')
    await service.install()
    expect(applied).toHaveLength(1)
    expect(applied[0]).toContain(dir)
  })

  it('reports up to date, surfaces check errors as retryable, and never runs when disabled or from source', async () => {
    const same = new UpdateService({ currentVersion: '0.2.0', repository: 'o/r', install: linuxInstall, arch, platform: 'linux', fetch: feedWith('v0.2.0') })
    expect(await same.check('test')).toBe(false)
    expect(same.getSnapshot().status).toBe('up-to-date')
    expect(updateActionLabel(same.getSnapshot())).toBe('Check for updates')

    const broken = new UpdateService({ currentVersion: '0.1.0', repository: 'o/r', install: linuxInstall, arch, platform: 'linux', fetch: routes({ 'releases/latest': () => new Response('', { status: 503 }) }) })
    await broken.check('test')
    expect(broken.getSnapshot()).toMatchObject({ status: 'error', errorContext: 'check', message: 'GitHub responded 503' })
    expect(updateActionLabel(broken.getSnapshot())).toBe('Retry')

    const source = new UpdateService({ currentVersion: '0.1.0', repository: 'o/r', install: { kind: 'source', root: '/x' }, arch, platform: 'linux', fetch: feedWith('v0.2.0') })
    expect(source.getSnapshot().status).toBe('disabled')
    expect(await source.check('test')).toBe(false)
    expect(updateActionLabel(source.getSnapshot())).toBeNull()

    const off = new UpdateService({ currentVersion: '0.1.0', repository: 'o/r', enabled: false, install: linuxInstall, arch, platform: 'linux', fetch: feedWith('v0.2.0') })
    expect(off.getSnapshot().status).toBe('disabled')
  })

  it('points package-managed installs at their upgrade command instead of downloading', async () => {
    const brew = new UpdateService({ currentVersion: '0.1.0', repository: 'o/r', platform: 'darwin', arch, install: { kind: 'homebrew', root: '/Applications/Heddlework.app', managedCommand: 'brew upgrade --cask heddlework' }, fetch: feedWith('v0.2.0') })
    expect(await brew.check('test')).toBe(true)
    expect(brew.getSnapshot().status).toBe('available')
    expect(updateStatusLabel(brew.getSnapshot())).toContain('brew upgrade --cask heddlework')
    expect(updateActionLabel(brew.getSnapshot())).toBe('Check for updates')
  })

  it('marks a checksum mismatch as a download error with retry', async () => {
    const dir = tmp()
    const fetchImpl = routes({
      'releases/latest': json({ tag_name: 'v0.2.0', assets: [
        { name: 'heddlework-linux-x64.tar.gz', browser_download_url: 'https://dl/heddlework-linux-x64.tar.gz', size: 3 },
        { name: 'checksums.txt', browser_download_url: 'https://dl/checksums.txt', size: 1 },
      ] }),
      'dl/checksums.txt': () => new Response(`${'ab'.repeat(32)}  heddlework-linux-x64.tar.gz\n`),
      'dl/heddlework-linux-x64.tar.gz': () => new Response('bad'),
    })
    const service = new UpdateService({ currentVersion: '0.1.0', repository: 'o/r', install: linuxInstall, arch, platform: 'linux', workdir: dir, fetch: fetchImpl })
    await service.check('test')
    expect(service.getSnapshot()).toMatchObject({ status: 'error', errorContext: 'download', availableVersion: '0.2.0' })
    expect(updateStatusLabel(service.getSnapshot())).toContain('Download failed for 0.2.0')
  })

  it('switches channel, persists it, and refuses while busy', async () => {
    const persisted: string[] = []
    const service = new UpdateService({ currentVersion: '0.1.0', repository: 'o/r', install: linuxInstall, arch, platform: 'linux', autoDownload: false, persistChannel: (c) => persisted.push(c), fetch: routes({ 'releases?': json([{ tag_name: 'v0.2.0-rc.1', prerelease: true, assets: [] }]), 'releases/latest': json({ tag_name: 'v0.1.0' }) }) })
    await service.setChannel('prerelease')
    expect(persisted).toEqual(['prerelease'])
    expect(service.getSnapshot()).toMatchObject({ channel: 'prerelease', status: 'available', availableVersion: '0.2.0-rc.1' })
    expect(updateActionLabel(service.getSnapshot())).toBe('Download')
    await service.setChannel('stable')
    expect(service.getSnapshot()).toMatchObject({ channel: 'stable', status: 'up-to-date', availableVersion: null })
  })
})
