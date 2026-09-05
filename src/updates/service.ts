import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { fetchLatestRelease, isNewerRelease, type ReleaseInfo, type UpdateChannel } from './feed.ts'
import {
  applyUpdate,
  detectInstall,
  detectRuntimeArch,
  downloadAsset,
  parseChecksums,
  pickReleaseAsset,
  stageUpdate,
  updateWorkdir,
  type CommandRunner,
  type InstallLocation,
  type RuntimeArch,
} from './installer.ts'

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  enabled: boolean
  status: UpdateStatus
  channel: UpdateChannel
  currentVersion: string
  install: InstallLocation
  arch: RuntimeArch
  availableVersion: string | null
  downloadedVersion: string | null
  releaseUrl: string | null
  releaseNotes: string | null
  downloadPercent: number | null
  checkedAt: string | null
  message: string | null
  errorContext: 'check' | 'download' | 'install' | null
}

export interface UpdateServiceOptions {
  currentVersion: string
  repository: string
  channel?: UpdateChannel | undefined
  enabled?: boolean | undefined
  autoDownload?: boolean | undefined
  fetch?: typeof fetch | undefined
  platform?: NodeJS.Platform | undefined
  install?: InstallLocation | undefined
  arch?: RuntimeArch | undefined
  workdir?: string | undefined
  run?: CommandRunner | undefined
  persistChannel?: ((channel: UpdateChannel) => void) | undefined
  apply?: typeof applyUpdate | undefined
  now?: (() => string) | undefined
}

export const UPDATE_POLL_INTERVAL_MS = 4 * 60_000
export const UPDATE_STARTUP_DELAY_MS = 10_000

// Mirrors t3code's DesktopUpdates: one state object, a poll loop, explicit check / download / install actions, and a channel switch. Downloads start automatically once an update is seen; installing waits for the user.
export class UpdateService {
  #state: UpdateState
  readonly #listeners = new Set<() => void>()
  readonly #options: UpdateServiceOptions
  #release: ReleaseInfo | undefined
  #staged: string | undefined
  #busy: 'check' | 'download' | 'install' | null = null
  #timer: ReturnType<typeof setTimeout> | undefined
  #abort: AbortController | undefined
  #disposed = false

  constructor(options: UpdateServiceOptions) {
    this.#options = options
    const platform = options.platform ?? process.platform
    const install = options.install ?? detectInstall({ platform })
    const enabled = (options.enabled ?? true) && install.kind !== 'source' && install.kind !== 'dev'
    this.#state = {
      enabled,
      status: enabled ? 'idle' : 'disabled',
      channel: options.channel ?? 'stable',
      currentVersion: options.currentVersion,
      install,
      arch: options.arch ?? detectRuntimeArch(platform),
      availableVersion: null,
      downloadedVersion: null,
      releaseUrl: null,
      releaseNotes: null,
      downloadPercent: null,
      checkedAt: null,
      message: enabled ? null
        : install.kind === 'source' ? 'Automatic updates are only available in packaged builds.'
        : install.kind === 'dev' ? 'This is a development install; rebuild it with bun run install:dev.'
        : 'Automatic updates are turned off.',
      errorContext: null,
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): UpdateState => this.#state

  get busy(): boolean {
    return this.#busy !== null
  }

  #set(patch: Partial<UpdateState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }

  #now(): string {
    return this.#options.now?.() ?? new Date().toISOString()
  }

  #workdir(): string {
    return this.#options.workdir ?? updateWorkdir()
  }

  // Starts the startup check and the poll loop. Safe to call once; dispose() stops it.
  start(): void {
    if (!this.#state.enabled || this.#disposed) return
    const schedule = (delay: number) => {
      this.#timer = setTimeout(() => {
        void this.check('poll').finally(() => {
          if (!this.#disposed) schedule(UPDATE_POLL_INTERVAL_MS)
        })
      }, delay)
      this.#timer.unref?.()
    }
    schedule(UPDATE_STARTUP_DELAY_MS)
  }

  dispose(): void {
    this.#disposed = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#abort?.abort()
    this.#listeners.clear()
  }

  async setChannel(channel: UpdateChannel): Promise<void> {
    if (channel === this.#state.channel) return
    if (this.#busy) throw new Error(`Cannot change the update channel while an update ${this.#busy} is in progress.`)
    this.#options.persistChannel?.(channel)
    this.#release = undefined
    this.#discardStaged()
    this.#set({ channel, status: this.#state.enabled ? 'idle' : 'disabled', availableVersion: null, downloadedVersion: null, releaseUrl: null, releaseNotes: null, downloadPercent: null, message: null, errorContext: null })
    if (this.#state.enabled) await this.check('channel')
  }

  // Asks the feed for the newest release on the channel. Resolves true when a newer version exists.
  async check(reason: string): Promise<boolean> {
    void reason
    if (!this.#state.enabled || this.#disposed) return false
    if (this.#busy) return this.#state.availableVersion !== null
    if (this.#state.status === 'downloaded') return true
    this.#busy = 'check'
    this.#set({ status: 'checking', message: null, errorContext: null })
    try {
      const release = await fetchLatestRelease({ repository: this.#options.repository, channel: this.#state.channel, currentVersion: this.#state.currentVersion, fetch: this.#options.fetch })
      const checkedAt = this.#now()
      if (!release || !isNewerRelease(release, this.#state.currentVersion, this.#state.channel)) {
        this.#release = undefined
        this.#set({ status: 'up-to-date', checkedAt, availableVersion: null, releaseUrl: null, releaseNotes: null, message: null })
        return false
      }
      this.#release = release
      this.#set({ status: 'available', checkedAt, availableVersion: release.version, releaseUrl: release.url || null, releaseNotes: release.notes || null, message: null })
      this.#busy = null
      if (this.#options.autoDownload !== false && !this.#state.install.managedCommand) await this.download()
      return true
    } catch (error) {
      this.#set({ status: 'error', errorContext: 'check', checkedAt: this.#now(), message: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      if (this.#busy === 'check') this.#busy = null
    }
  }

  // Downloads the platform asset for the available release, verifies its checksum, and stages it ready to install.
  async download(): Promise<void> {
    const release = this.#release
    if (!release || this.#busy || this.#state.status === 'downloaded' || this.#disposed) return
    if (this.#state.install.managedCommand) {
      this.#set({ status: 'available', message: `This install is managed by a package manager. Run: ${this.#state.install.managedCommand}` })
      return
    }
    const platform = this.#options.platform ?? process.platform
    const asset = pickReleaseAsset(release.assets, platform, this.#state.arch)
    if (!asset) {
      this.#set({ status: 'error', errorContext: 'download', message: `Release ${release.version} has no download for this platform.` })
      return
    }
    this.#busy = 'download'
    this.#abort = new AbortController()
    this.#set({ status: 'downloading', downloadPercent: 0, message: null, errorContext: null })
    try {
      const workdir = join(this.#workdir(), release.version)
      rmSync(workdir, { recursive: true, force: true })
      mkdirSync(workdir, { recursive: true })
      const checksums = release.assets.find((candidate) => candidate.name === 'checksums.txt')
      let expected: string | undefined
      if (checksums) {
        const fetchImpl = this.#options.fetch ?? globalThis.fetch
        const response = await fetchImpl(checksums.url, { signal: this.#abort.signal, redirect: 'follow' })
        if (response.ok) expected = parseChecksums(await response.text()).get(asset.name)
      }
      const archive = join(workdir, asset.name)
      await downloadAsset({ asset, expectedSha256: expected, destination: archive, fetch: this.#options.fetch, signal: this.#abort.signal, onProgress: (percent) => this.#set({ downloadPercent: percent }) })
      this.#staged = await stageUpdate({ archive, location: this.#state.install, workdir, run: this.#options.run, platform })
      this.#set({ status: 'downloaded', downloadedVersion: release.version, downloadPercent: 100, message: null })
    } catch (error) {
      this.#discardStaged()
      const aborted = this.#abort?.signal.aborted
      this.#set({ status: aborted ? 'available' : 'error', errorContext: aborted ? null : 'download', downloadPercent: null, message: aborted ? null : error instanceof Error ? error.message : String(error) })
    } finally {
      this.#busy = null
      this.#abort = undefined
    }
  }

  // Swaps the staged update into place and relaunches. The process exits on success, so nothing after this runs.
  async install(): Promise<void> {
    if (!this.#staged || this.#busy || this.#disposed) return
    if (!existsSync(this.#staged)) {
      this.#staged = undefined
      this.#set({ status: 'available', downloadedVersion: null, message: 'The downloaded update is no longer on disk. Download it again.' })
      return
    }
    this.#busy = 'install'
    try {
      await (this.#options.apply ?? applyUpdate)({ staged: this.#staged, location: this.#state.install, platform: this.#options.platform })
    } catch (error) {
      this.#set({ status: 'error', errorContext: 'install', message: error instanceof Error ? error.message : String(error) })
    } finally {
      this.#busy = null
    }
  }

  async retry(): Promise<void> {
    if (this.#state.status !== 'error') return
    if (this.#state.errorContext === 'install' && this.#staged) return this.install()
    if (this.#state.errorContext === 'download' && this.#release) return this.download()
    await this.check('retry')
  }

  #discardStaged(): void {
    if (this.#staged) rmSync(this.#staged, { recursive: true, force: true })
    this.#staged = undefined
  }
}
