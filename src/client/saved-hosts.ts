// Hosts this device has connected to. Browser-safe contract with a pluggable persistence backend.

import type { HostIdentity, HostMachineKind, HostOs } from '../protocol/host-identity.ts'

export interface SavedHost {
  // The host's stable identity id when known, else a hash of the URL so a host that predates identity still has a row.
  id: string
  name: string
  url: string
  token: string
  // Every address the host has advertised, so reconnects can rotate when one is unreachable.
  hostUrls: string[]
  machine: HostMachineKind
  os: HostOs
  lastSeenAt: number
  lastWorkspacePath?: string | undefined
  // Set when the user renamed the row; the host's own name no longer overwrites it.
  customName?: boolean | undefined
}

export interface SavedHostsBackend {
  read(): unknown
  write(value: unknown): void
}

export const SAVED_HOSTS_LIMIT = 24

export function restoreSavedHosts(value: unknown): SavedHost[] {
  if (!value || typeof value !== 'object') return []
  const rows = Array.isArray(value) ? value : (value as { hosts?: unknown }).hosts
  if (!Array.isArray(rows)) return []
  const restored: SavedHost[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const host = row as Record<string, unknown>
    if (typeof host.id !== 'string' || !host.id || typeof host.url !== 'string' || !host.url || typeof host.token !== 'string' || !host.token) continue
    restored.push({
      id: host.id,
      name: typeof host.name === 'string' && host.name.trim() ? host.name.trim() : hostLabelFromUrl(host.url),
      url: host.url,
      token: host.token,
      hostUrls: Array.isArray(host.hostUrls) ? host.hostUrls.filter((entry): entry is string => typeof entry === 'string') : [],
      machine: typeof host.machine === 'string' ? (host.machine as HostMachineKind) : 'server',
      os: host.os === 'darwin' || host.os === 'linux' || host.os === 'windows' ? host.os : 'unknown',
      lastSeenAt: typeof host.lastSeenAt === 'number' && Number.isFinite(host.lastSeenAt) ? host.lastSeenAt : 0,
      ...(typeof host.lastWorkspacePath === 'string' ? { lastWorkspacePath: host.lastWorkspacePath } : {}),
      ...(host.customName === true ? { customName: true } : {}),
    })
  }
  return restored.sort((left, right) => right.lastSeenAt - left.lastSeenAt).slice(0, SAVED_HOSTS_LIMIT)
}

export function hostLabelFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.hostname
  } catch {
    return url
  }
}

// Stable id for hosts that never sent an identity: a short FNV-1a of the URL.
export function savedHostIdForUrl(url: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `url-${hash.toString(16).padStart(8, '0')}`
}

export class SavedHostsStore {
  readonly #backend: SavedHostsBackend
  readonly #listeners = new Set<() => void>()
  #hosts: SavedHost[]

  constructor(backend: SavedHostsBackend) {
    this.#backend = backend
    let raw: unknown
    try { raw = backend.read() } catch { raw = undefined }
    this.#hosts = restoreSavedHosts(raw)
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  list(): readonly SavedHost[] { return this.#hosts }

  get(id: string): SavedHost | undefined { return this.#hosts.find((host) => host.id === id) }

  // Records a successful connection. The identity (when the host sent one) wins over a URL-derived row for the same address.
  remember(connection: { url: string; token: string; hostUrls?: readonly string[] | undefined; identity?: HostIdentity | undefined; workspacePath?: string | undefined; now?: number | undefined }): SavedHost {
    const now = connection.now ?? Date.now()
    const id = connection.identity?.id ?? savedHostIdForUrl(connection.url)
    const existing = this.get(id) ?? this.#hosts.find((host) => host.url === connection.url)
    const next: SavedHost = {
      id,
      name: existing?.customName ? existing.name : connection.identity?.name?.trim() || existing?.name || hostLabelFromUrl(connection.url),
      url: connection.url,
      token: connection.token,
      hostUrls: [...new Set([connection.url, ...(connection.hostUrls ?? []), ...(existing?.hostUrls ?? [])])],
      machine: connection.identity?.machine ?? existing?.machine ?? 'server',
      os: connection.identity?.os ?? existing?.os ?? 'unknown',
      lastSeenAt: now,
      ...(connection.workspacePath ? { lastWorkspacePath: connection.workspacePath } : existing?.lastWorkspacePath ? { lastWorkspacePath: existing.lastWorkspacePath } : {}),
      ...(existing?.customName ? { customName: true } : {}),
    }
    this.#hosts = [next, ...this.#hosts.filter((host) => host.id !== id && host.id !== existing?.id)].slice(0, SAVED_HOSTS_LIMIT)
    this.#commit()
    return next
  }

  rename(id: string, name: string): void {
    const trimmed = name.replace(/\s+/g, ' ').trim().slice(0, 60)
    const host = this.get(id)
    if (!host || !trimmed) return
    this.#hosts = this.#hosts.map((entry) => entry.id === id ? { ...entry, name: trimmed, customName: true } : entry)
    this.#commit()
  }

  forget(id: string): void {
    if (!this.get(id)) return
    this.#hosts = this.#hosts.filter((host) => host.id !== id)
    this.#commit()
  }

  #commit(): void {
    try { this.#backend.write({ version: 1, hosts: this.#hosts }) } catch { /* Saved hosts stay usable in memory. */ }
    for (const listener of this.#listeners) listener()
  }
}

export function memorySavedHostsBackend(initial: unknown = undefined): SavedHostsBackend {
  let value = initial
  return { read: () => value, write: (next) => { value = next } }
}

export function storageSavedHostsBackend(storage: Pick<Storage, 'getItem' | 'setItem'>, key = 'heddlework.savedHosts'): SavedHostsBackend {
  return {
    read: () => { const raw = storage.getItem(key); return raw ? JSON.parse(raw) as unknown : undefined },
    write: (value) => storage.setItem(key, JSON.stringify(value)),
  }
}
