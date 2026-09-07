// Browser implementation of HostSwitcherSurface. There is never a local runtime in this process.

import { parseConnectLink, type HostSwitcherSnapshot, type HostSwitcherSurface } from '../client/host-switcher.ts'
import { SavedHostsStore, storageSavedHostsBackend } from '../client/saved-hosts.ts'
import type { HostIdentity } from '../protocol/host-identity.ts'
import type { WorkspaceClientStatus } from './client.ts'

export interface WebHostClient {
  subscribe(listener: () => void): () => void
  getSnapshot(): {
    status: WorkspaceClientStatus
    host?: HostIdentity | undefined
    url?: string | undefined
    lastError?: string | undefined
    workspacePath?: string | undefined
  }
  connect(url: string, token: string, alternates?: readonly string[]): void
  readonly candidates: readonly string[]
}

export class WebHostSwitcher implements HostSwitcherSurface {
  readonly #client: WebHostClient
  readonly #storage: Pick<Storage, 'getItem' | 'setItem'>
  readonly #savedHosts: SavedHostsStore
  readonly #listeners = new Set<() => void>()
  #busy = false
  #url = ''
  #token = ''
  #savedId: string | undefined
  #lastStatus: WorkspaceClientStatus | undefined

  constructor(
    client: WebHostClient,
    storage: Pick<Storage, 'getItem' | 'setItem'>,
    savedHosts: SavedHostsStore = new SavedHostsStore(storageSavedHostsBackend(storage)),
  ) {
    this.#client = client
    this.#storage = storage
    this.#savedHosts = savedHosts
    this.#url = storage.getItem('heddlework.host') ?? ''
    this.#token = storage.getItem('heddlework.token') ?? ''
    client.subscribe(() => this.#onClient())
    savedHosts.subscribe(() => this.#emit())
    this.#onClient()
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  getSnapshot(): HostSwitcherSnapshot {
    const view = this.#client.getSnapshot()
    const savedId = this.#savedId ?? view.host?.id
    return {
      current: {
        origin: 'remote',
        identity: view.host ?? undefined,
        url: view.url ?? (this.#url || this.#storage.getItem('heddlework.host') || ''),
        status: view.status,
        ...(view.lastError ? { lastError: view.lastError } : {}),
        ...(savedId && this.#savedHosts.get(savedId) ? { savedId } : {}),
      },
      saved: this.#savedHosts.list(),
      busy: this.#busy || view.status === 'connecting',
      canUseLocal: false,
    }
  }

  async connect(target: { link: string } | { savedId: string }): Promise<void> {
    if ('link' in target) {
      const parsed = parseConnectLink(target.link)
      if (!parsed) return Promise.reject(new Error('Invalid connect link'))
      this.#begin(parsed.url, parsed.token, this.#alternatesFor(parsed.url), undefined)
      return
    }
    const row = this.#savedHosts.get(target.savedId)
    if (!row) return Promise.reject(new Error('Unknown saved host'))
    this.#begin(row.url, row.token, row.hostUrls, row.id)
  }

  useLocal(): Promise<void> {
    return Promise.reject(new Error('This browser has no local runtime'))
  }

  forget(savedId: string): void {
    this.#savedHosts.forget(savedId)
  }

  rename(savedId: string, name: string): void {
    this.#savedHosts.rename(savedId, name)
  }

  #begin(url: string, token: string, alternates: readonly string[], savedId: string | undefined): void {
    this.#busy = true
    this.#url = url
    this.#token = token
    this.#savedId = savedId
    this.#storage.setItem('heddlework.host', url)
    this.#storage.setItem('heddlework.token', token)
    this.#client.connect(url, token, alternates)
    this.#emit()
  }

  #alternatesFor(url: string): readonly string[] {
    const row = this.#savedHosts.list().find((host) => host.url === url || host.hostUrls.includes(url))
    return row?.hostUrls ?? []
  }

  #onClient(): void {
    const view = this.#client.getSnapshot()
    if (view.status === 'open') this.#busy = false
    if (view.status === 'open' && view.host && this.#lastStatus !== 'open') {
      const url = view.url ?? (this.#url || this.#storage.getItem('heddlework.host') || '')
      const token = this.#token || this.#storage.getItem('heddlework.token') || ''
      if (url && token) {
        this.#savedHosts.remember({
          url,
          token,
          hostUrls: this.#client.candidates,
          identity: view.host,
          ...(view.workspacePath ? { workspacePath: view.workspacePath } : {}),
        })
        try { this.#storage.setItem('heddlework.hostUrls', JSON.stringify([...this.#client.candidates])) } catch { /* Candidates stay on the client. */ }
      }
    }
    this.#lastStatus = view.status
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}
