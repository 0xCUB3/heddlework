import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, dirname, join, posix, resolve, win32 } from 'node:path'
import type { ReleaseAsset } from './feed.ts'

export type InstallKind = 'macos-app' | 'linux-portable' | 'windows-portable' | 'homebrew' | 'scoop' | 'linux-package' | 'source'

export interface InstallLocation {
  kind: InstallKind
  // The path that gets replaced: the .app bundle on macOS, or the directory holding the binary and web/ elsewhere.
  root: string
  // Set when a package manager owns the install and in-app replacement would fight it.
  managedCommand?: string | undefined
}

export interface DetectInstallOptions {
  platform?: NodeJS.Platform | undefined
  execPath?: string | undefined
  environment?: NodeJS.ProcessEnv | undefined
  exists?: ((path: string) => boolean) | undefined
  // Resolves symlinks; used to match the Homebrew Caskroom link against the running bundle.
  realpath?: ((path: string) => string | undefined) | undefined
  readdir?: ((path: string) => string[]) | undefined
}

function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

// Homebrew installs the .app in /Applications and leaves a symlink in the Caskroom. The bundle is brew-owned only when one of those links resolves to it.
function homebrewOwns(root: string, exists: (path: string) => boolean, realpath: (path: string) => string | undefined, readdir: (path: string) => string[]): boolean {
  const real = realpath(root) ?? root
  for (const caskroom of ['/opt/homebrew/Caskroom/heddlework', '/usr/local/Caskroom/heddlework']) {
    if (!exists(caskroom)) continue
    let versions: string[] = []
    try {
      versions = readdir(caskroom)
    } catch {
      continue
    }
    for (const version of versions) {
      const link = join(caskroom, version, basename(root))
      if (exists(link) && (realpath(link) ?? link) === real) return true
    }
  }
  return false
}

// Works out how this binary was installed so the updater knows whether it may replace files and how to relaunch.
export function detectInstall(options: DetectInstallOptions = {}): InstallLocation {
  const platform = options.platform ?? process.platform
  const paths = platform === 'win32' ? win32 : posix
  const execPath = options.execPath ? paths.resolve(options.execPath) : resolve(process.execPath)
  const environment = options.environment ?? process.env
  const exists = options.exists ?? existsSync
  const realpath = options.realpath ?? safeRealpath
  const readdir = options.readdir ?? readdirSync
  const executable = paths.basename(execPath).toLowerCase()
  if (executable === 'bun' || executable === 'bun.exe' || executable === 'node' || executable === 'node.exe') {
    return { kind: 'source', root: paths.dirname(execPath) }
  }
  if (platform === 'darwin') {
    const match = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)
    if (!match) return { kind: 'source', root: dirname(execPath) }
    const root = match[1]!
    if (homebrewOwns(root, exists, realpath, readdir)) return { kind: 'homebrew', root, managedCommand: 'brew upgrade --cask heddlework' }
    return { kind: 'macos-app', root }
  }
  if (platform === 'win32') {
    const root = paths.dirname(execPath)
    if (/[\\/]scoop[\\/]apps[\\/]/i.test(execPath)) return { kind: 'scoop', root, managedCommand: 'scoop update heddlework' }
    if (/[\\/]WinGet[\\/]Packages[\\/]/i.test(execPath)) return { kind: 'scoop', root, managedCommand: 'winget upgrade 0xCUB3.Heddlework' }
    return { kind: 'windows-portable', root }
  }
  const root = dirname(execPath)
  if (execPath.startsWith('/usr/lib/heddlework/') || execPath.startsWith('/usr/bin/') || execPath.startsWith('/usr/local/lib/heddlework/')) {
    const manager = exists('/usr/bin/apt-get') ? 'sudo apt install --only-upgrade heddlework' : exists('/usr/bin/dnf') ? 'sudo dnf upgrade heddlework' : 'your package manager'
    return { kind: 'linux-package', root, managedCommand: manager }
  }
  void environment
  return { kind: 'linux-portable', root }
}

export interface RuntimeArch {
  appArch: 'arm64' | 'x64' | 'other'
  hostArch: 'arm64' | 'x64' | 'other'
  translated: boolean
}

function normaliseArch(value: string): RuntimeArch['appArch'] {
  return value === 'arm64' ? 'arm64' : value === 'x64' ? 'x64' : 'other'
}

// Reports the running architecture and whether macOS is translating an Intel build under Rosetta, in which case updates prefer the arm64 asset.
export function detectRuntimeArch(platform: NodeJS.Platform = process.platform, arch: string = process.arch, sysctl: (name: string) => string | undefined = readSysctl): RuntimeArch {
  const appArch = normaliseArch(arch)
  if (platform !== 'darwin' || appArch !== 'x64') return { appArch, hostArch: appArch, translated: false }
  const translated = sysctl('sysctl.proc_translated')?.trim() === '1'
  return { appArch, hostArch: translated ? 'arm64' : appArch, translated }
}

function readSysctl(name: string): string | undefined {
  try {
    return Bun.spawnSync(['sysctl', '-n', name], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString()
  } catch {
    return undefined
  }
}

// Picks the release asset for this platform. Signed and unsigned Windows zips share a prefix, so the match is prefix plus extension.
export function pickReleaseAsset(assets: readonly ReleaseAsset[], platform: NodeJS.Platform, arch: RuntimeArch): ReleaseAsset | undefined {
  const target = arch.hostArch === 'other' ? arch.appArch : arch.hostArch
  const spec = platform === 'darwin' ? { prefix: `heddlework-macos-${target}`, extension: '.zip' }
    : platform === 'win32' ? { prefix: 'heddlework-windows-x64', extension: '.zip' }
    : { prefix: 'heddlework-linux-x64', extension: '.tar.gz' }
  const matches = assets.filter((asset) => asset.name.startsWith(spec.prefix) && asset.name.endsWith(spec.extension))
  return matches.find((asset) => asset.name === `${spec.prefix}${spec.extension}`) ?? matches[0]
}

export function parseChecksums(text: string): Map<string, string> {
  const sums = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$/.exec(line)
    if (match) sums.set(basename(match[2]!), match[1]!.toLowerCase())
  }
  return sums
}

export interface DownloadOptions {
  asset: ReleaseAsset
  expectedSha256?: string | undefined
  destination: string
  fetch?: typeof fetch | undefined
  onProgress?: ((percent: number | null) => void) | undefined
  signal?: AbortSignal | undefined
}

// Streams the asset to disk, reporting progress, and verifies the sha256 when a checksum is known.
export async function downloadAsset(options: DownloadOptions): Promise<string> {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const response = await fetchImpl(options.asset.url, { headers: { 'user-agent': 'heddlework-updater' }, ...(options.signal ? { signal: options.signal } : {}), redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`Download failed with status ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? options.asset.size) || 0
  mkdirSync(dirname(options.destination), { recursive: true })
  const hash = createHash('sha256')
  const writer = Bun.file(options.destination).writer()
  let received = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (!value) continue
      hash.update(value)
      writer.write(value)
      received += value.byteLength
      options.onProgress?.(total > 0 ? Math.min(100, (received / total) * 100) : null)
    }
    await writer.end()
  } catch (error) {
    try { await writer.end() } catch { /* the partial file is removed below */ }
    rmSync(options.destination, { force: true })
    throw error
  }
  const digest = hash.digest('hex')
  if (options.expectedSha256 && digest !== options.expectedSha256.toLowerCase()) {
    rmSync(options.destination, { force: true })
    throw new Error('Downloaded file did not match the published checksum')
  }
  return digest
}

export type CommandRunner = (command: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>

export const runCommand: CommandRunner = (command, args) =>
  new Promise((resolveRun) => {
    execFile(command, args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolveRun({ code: error && typeof (error as { code?: unknown }).code === 'number' ? Number((error as { code: number }).code) : error ? 1 : 0, stdout: String(stdout), stderr: String(stderr) })
    })
  })

export interface StageOptions {
  archive: string
  location: InstallLocation
  workdir: string
  run?: CommandRunner | undefined
  platform?: NodeJS.Platform | undefined
}

// Unpacks the archive next to the download and returns the payload path: an .app on macOS, or a directory holding heddlework plus web/ elsewhere. macOS payloads must pass codesign before they are accepted.
export async function stageUpdate(options: StageOptions): Promise<string> {
  const run = options.run ?? runCommand
  const platform = options.platform ?? process.platform
  const extracted = join(options.workdir, 'extracted')
  rmSync(extracted, { recursive: true, force: true })
  mkdirSync(extracted, { recursive: true })
  const unpack = platform === 'darwin'
    ? await run('ditto', ['-x', '-k', options.archive, extracted])
    : platform === 'win32'
      ? await run('tar', ['-xf', options.archive, '-C', extracted])
      : await run('tar', ['-xzf', options.archive, '-C', extracted])
  if (unpack.code !== 0) throw new Error(`Could not unpack the update: ${unpack.stderr.trim() || `exit ${unpack.code}`}`)
  const entries = readdirSync(extracted)
  if (platform === 'darwin') {
    const app = entries.find((entry) => entry.endsWith('.app'))
    if (!app) throw new Error('The update archive did not contain an application bundle')
    const appPath = join(extracted, app)
    const verify = await run('codesign', ['--verify', '--deep', '--strict', appPath])
    if (verify.code !== 0) throw new Error(`The downloaded app failed signature verification: ${verify.stderr.trim()}`)
    return appPath
  }
  const payload = entries.length === 1 && statSync(join(extracted, entries[0]!)).isDirectory() ? join(extracted, entries[0]!) : extracted
  const binary = platform === 'win32' ? 'heddlework.exe' : 'heddlework'
  if (!existsSync(join(payload, binary))) throw new Error(`The update archive did not contain ${binary}`)
  return payload
}

export interface ApplyOptions {
  staged: string
  location: InstallLocation
  platform?: NodeJS.Platform | undefined
  execPath?: string | undefined
  args?: readonly string[] | undefined
  relaunch?: boolean | undefined
  spawnDetached?: ((command: string, args: string[]) => void) | undefined
  exit?: ((code: number) => void) | undefined
  pid?: number | undefined
}

function spawnDetachedProcess(command: string, args: string[]): void {
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.unref()
}

// Swaps the staged payload into place and relaunches. macOS and Linux replace files directly; Windows cannot overwrite a running exe, so a helper script does the swap after this process exits.
export async function applyUpdate(options: ApplyOptions): Promise<void> {
  const platform = options.platform ?? process.platform
  const execPath = options.execPath ?? process.execPath
  const args = [...(options.args ?? process.argv.slice(1))]
  const spawnDetached = options.spawnDetached ?? spawnDetachedProcess
  const exit = options.exit ?? ((code: number) => process.exit(code))
  const { root } = options.location

  if (options.location.managedCommand) {
    throw new Error(`This install is managed by a package manager. Run: ${options.location.managedCommand}`)
  }

  if (platform === 'win32') {
    const script = join(dirname(options.staged), 'apply-update.cmd')
    const pid = options.pid ?? process.pid
    const quoted = args.map((arg) => `"${arg.replace(/"/g, '""')}"`).join(' ')
    const exe = win32.join(root, 'heddlework.exe')
    writeFileSync(script, [
      '@echo off',
      ':wait',
      `tasklist /FI "PID eq ${pid}" 2>nul | find "${pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
      `move /y "${win32.join(options.staged, 'heddlework.exe')}" "${exe}" >nul`,
      `if exist "${win32.join(root, 'web')}" rmdir /s /q "${win32.join(root, 'web')}"`,
      `if exist "${win32.join(options.staged, 'web')}" move /y "${win32.join(options.staged, 'web')}" "${win32.join(root, 'web')}" >nul`,
      ...(options.relaunch === false ? [] : [`start "" "${exe}" ${quoted}`]),
      '',
    ].join('\r\n'), 'utf8')
    spawnDetached('cmd.exe', ['/c', script])
    exit(0)
    return
  }

  if (platform === 'darwin') {
    const previous = `${root}.previous`
    rmSync(previous, { recursive: true, force: true })
    renameSync(root, previous)
    try {
      renameSync(options.staged, root)
    } catch (error) {
      renameSync(previous, root)
      throw error
    }
    rmSync(previous, { recursive: true, force: true })
    if (options.relaunch !== false) spawnDetached('open', ['-n', root, '--args', ...args])
    exit(0)
    return
  }

  const backup = join(tmpdir(), `heddlework-previous-${Date.now()}`)
  mkdirSync(backup, { recursive: true })
  for (const entry of ['heddlework', 'web']) {
    const current = join(root, entry)
    if (existsSync(current)) renameSync(current, join(backup, entry))
  }
  try {
    for (const entry of ['heddlework', 'web']) {
      const incoming = join(options.staged, entry)
      if (existsSync(incoming)) renameSync(incoming, join(root, entry))
    }
  } catch (error) {
    for (const entry of ['heddlework', 'web']) {
      const saved = join(backup, entry)
      if (existsSync(saved)) {
        rmSync(join(root, entry), { recursive: true, force: true })
        renameSync(saved, join(root, entry))
      }
    }
    throw error
  }
  rmSync(backup, { recursive: true, force: true })
  if (options.relaunch !== false) spawnDetached(execPath, args)
  exit(0)
}

export function updateWorkdir(base: string = tmpdir()): string {
  return join(base, 'heddlework-update')
}
