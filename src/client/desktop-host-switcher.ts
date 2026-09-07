// Desktop implementation of HostSwitcherSurface: one active host, a saved list, and a local runtime to fall back to.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HostSwitcherSnapshot, HostSwitcherSurface, CurrentHost } from './host-switcher.ts'
import { parseConnectLink } from './host-switcher.ts'
import type { SavedHostsBackend, SavedHostsStore } from './saved-hosts.ts'
import type { RemoteClientServices, RuntimeAttachDescriptor } from './runtime-attach.ts'

export const HOST_CONNECT_TIMEOUT_MS = 15_000
export const HOST_RESTORE_TIMEOUT_MS = 8_000

export type HostServicesDescriptor = RuntimeAttachDescriptor & {
  origin: 'local' | 'remote'
  savedId?: string | undefined
}

export interface DesktopHostSwitcherOptions {
  local: { descriptor: RuntimeAttachDescriptor }
  savedHosts: SavedHostsStore
  buildServices(descriptor: HostServicesDescriptor): Promise<RemoteClientServices>
  onServices(services: RemoteClientServices, current: CurrentHost): void
  lastHostPath?: string | false | undefined
  connectTimeoutMs?: number | undefined
  restoreTimeoutMs?: number | undefined
}

interface ActiveHost {
  services: RemoteClientServices
  descriptor: HostServicesDescriptor
}

export function fileSavedHostsBackend(path: string): SavedHostsBackend {
  return {
    read() {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown
      } catch {
        return undefined
      }
    },
    write(value) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    },
  }
}

export class DesktopHostSwitcher implements HostSwitcherSurface {
  readonly #local: RuntimeAttachDescriptor
  readonly #savedHosts: SavedHostsStore
  readonly #buildServices: DesktopHostSwitcherOptions['buildServices']
  readonly #onServices: DesktopHostSwitcherOptions['onServices']
  readonly #lastHostPath: string | false
  readonly #connectTimeoutMs: number
  readonly #restoreTimeoutMs: number
  readonly #listeners = new Set<() => void>()
  #unsubSaved: (() => void) | undefined
  #unsubClient: (() => void) | undefined
  #active: ActiveHost | undefined
  #busy = false
  #switchError: string | undefined
  #current: CurrentHost
  #snapshot: HostSwitcherSnapshot

  constructor(options: DesktopHostSwitcherOptions) {
    this.#local = options.local.descriptor
    this.#savedHosts = options.savedHosts
    this.#buildServices = options.buildServices
    this.#onServices = options.onServices
    this.#lastHostPath = options.lastHostPath ?? false
    this.#connectTimeoutMs = options.connectTimeoutMs ?? HOST_CONNECT_TIMEOUT_MS
    this.#restoreTimeoutMs = options.restoreTimeoutMs ?? HOST_RESTORE_TIMEOUT_MS
    this.#current = {
      origin: 'local',
      identity: undefined,
      url: this.#local.workspaceUrl,
      status: 'connecting',
    }
    this.#snapshot = this.#computeSnapshot()
    this.#unsubSaved = this.#savedHosts.subscribe(() => this.#emit())
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  getSnapshot(): HostSwitcherSnapshot {
    return this.#snapshot
  }

  services(): RemoteClientServices | undefined {
    return this.#active?.services
  }

  async start(localServices: RemoteClientServices): Promise<void> {
    const lastId = this.#readLastSavedId()
    const saved = lastId ? this.#savedHosts.get(lastId) : undefined
    if (saved) {
      try {
        const descriptor: HostServicesDescriptor = {
          workspaceUrl: saved.url,
          token: saved.token,
          hostUrls: saved.hostUrls,
          controlUrl: saved.url,
          origin: 'remote',
          savedId: saved.id,
        }
        const services = await this.#buildWithTimeout(descriptor, this.#restoreTimeoutMs)
        await localServices.dispose()
        this.#finishConnect(services, descriptor)
        return
      } catch {
        // Fall through to the local runtime so startup always lands somewhere.
      }
    }
    this.#adopt(localServices, { ...this.#local, origin: 'local' })
    this.#onServices(localServices, this.#current)
  }

  async connect(target: { link: string } | { savedId: string }): Promise<void> {
    if ('link' in target) {
      const parsed = parseConnectLink(target.link)
      if (!parsed) throw new Error('Invalid connect link. Paste a link from Settings › Remote access.')
      await this.#switchTo({
        workspaceUrl: parsed.url,
        token: parsed.token,
        controlUrl: parsed.url,
        origin: 'remote',
      })
      return
    }
    const saved = this.#savedHosts.get(target.savedId)
    if (!saved) throw new Error('Unknown saved host')
    await this.#switchTo({
      workspaceUrl: saved.url,
      token: saved.token,
      hostUrls: saved.hostUrls,
      controlUrl: saved.url,
      origin: 'remote',
      savedId: saved.id,
    })
  }

  async useLocal(): Promise<void> {
    if (this.#active?.descriptor.origin === 'local') return
    await this.#switchTo({ ...this.#local, origin: 'local' })
  }

  forget(savedId: string): void {
    this.#savedHosts.forget(savedId)
    if (this.#readLastSavedId() === savedId) this.#writeLastSavedId(undefined)
  }

  rename(savedId: string, name: string): void {
    this.#savedHosts.rename(savedId, name)
  }

  async dispose(): Promise<void> {
    this.#unsubSaved?.()
    this.#unsubSaved = undefined
    this.#unbindClient()
    const active = this.#active
    this.#active = undefined
    await active?.services.dispose()
  }

  async #switchTo(descriptor: HostServicesDescriptor): Promise<void> {
    if (this.#busy) throw new Error('Already switching hosts')
    this.#busy = true
    this.#switchError = undefined
    this.#emit()
    const previous = this.#active
    try {
      if (previous) {
        await previous.services.dispose()
        this.#unbindClient()
        this.#active = undefined
      }
      const services = await this.#buildWithTimeout(descriptor, this.#connectTimeoutMs)
      this.#finishConnect(services, descriptor)
    } catch (error) {
      this.#switchError = error instanceof Error ? error.message : String(error)
      if (previous) {
        try {
          const restored = await this.#buildWithTimeout(previous.descriptor, this.#connectTimeoutMs)
          this.#finishConnect(restored, previous.descriptor)
        } catch {
          try {
            const local = await this.#buildWithTimeout({ ...this.#local, origin: 'local' }, this.#connectTimeoutMs)
            this.#finishConnect(local, { ...this.#local, origin: 'local' })
          } catch {
            // The picker still shows lastError; the user can retry.
          }
        }
      }
      throw error instanceof Error ? error : new Error(this.#switchError)
    } finally {
      this.#busy = false
      this.#emit()
    }
  }

  async #buildWithTimeout(descriptor: HostServicesDescriptor, timeoutMs: number): Promise<RemoteClientServices> {
    const pending = this.#buildServices(descriptor)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for workspace connection')), timeoutMs)
        }),
      ])
    } catch (error) {
      void pending.then((services) => services.dispose(), () => undefined)
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #finishConnect(services: RemoteClientServices, descriptor: HostServicesDescriptor): void {
    let savedId = descriptor.savedId
    if (descriptor.origin === 'remote') {
      const view = services.client.getSnapshot()
      const row = this.#savedHosts.remember({
        url: descriptor.workspaceUrl,
        token: descriptor.token,
        hostUrls: services.client.candidates,
        identity: view.host,
        workspacePath: view.workspacePath,
      })
      savedId = row.id
    }
    const next: HostServicesDescriptor = { ...descriptor, savedId }
    this.#adopt(services, next)
    this.#writeLastSavedId(next.origin === 'remote' ? savedId : undefined)
    this.#onServices(services, this.#current)
  }

  #adopt(services: RemoteClientServices, descriptor: HostServicesDescriptor): void {
    this.#unbindClient()
    this.#active = { services, descriptor }
    this.#bindClient(services, descriptor)
  }

  #bindClient(services: RemoteClientServices, descriptor: HostServicesDescriptor): void {
    const sync = (): void => {
      if (this.#active?.services !== services) return
      this.#current = this.#currentFrom(services, descriptor)
      this.#emit()
    }
    this.#unsubClient = services.client.subscribe(sync)
    this.#current = this.#currentFrom(services, descriptor)
    this.#emit()
  }

  #unbindClient(): void {
    this.#unsubClient?.()
    this.#unsubClient = undefined
  }

  #currentFrom(services: RemoteClientServices, descriptor: HostServicesDescriptor): CurrentHost {
    const view = services.client.getSnapshot()
    return {
      origin: descriptor.origin,
      identity: view.host,
      url: view.url ?? descriptor.workspaceUrl,
      status: view.status,
      lastError: this.#switchError ?? view.lastError,
      savedId: descriptor.savedId,
    }
  }

  #computeSnapshot(): HostSwitcherSnapshot {
    return {
      current: this.#current,
      saved: this.#savedHosts.list(),
      busy: this.#busy,
      canUseLocal: true,
    }
  }

  #emit(): void {
    this.#snapshot = this.#computeSnapshot()
    for (const listener of this.#listeners) listener()
  }

  #readLastSavedId(): string | undefined {
    if (!this.#lastHostPath) return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.#lastHostPath, 'utf8')) as { savedId?: unknown }
      return typeof parsed.savedId === 'string' && parsed.savedId ? parsed.savedId : undefined
    } catch {
      return undefined
    }
  }

  #writeLastSavedId(savedId: string | undefined): void {
    if (!this.#lastHostPath) return
    try {
      mkdirSync(dirname(this.#lastHostPath), { recursive: true })
      writeFileSync(this.#lastHostPath, `${JSON.stringify({ version: 1, ...(savedId ? { savedId } : {}) }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Last-host preference is best-effort.
    }
  }
}
