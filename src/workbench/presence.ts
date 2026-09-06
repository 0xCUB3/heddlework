export type PresenceSurface = 'desktop' | 'web' | 'ios'
export type PresenceVisibility = 'focused' | 'visible' | 'hidden'

export interface ClientPresence {
  clientId: string
  surface: PresenceSurface
  visibility: PresenceVisibility
  sessionPath?: string
  lastSeenAt: number
  lastFocusedAt?: number
}

export interface AttentionTarget {
  sessionPath?: string
  createdAt: number
}

export const PRESENCE_STALE_MS = 45_000
export const FOCUS_GRACE_MS = 2_000
export const DESKTOP_CLIENT_ID = 'desktop'

const SURFACES = new Set<PresenceSurface>(['desktop', 'web', 'ios'])
const VISIBILITIES = new Set<PresenceVisibility>(['focused', 'visible', 'hidden'])

export function isPresenceSurface(value: unknown): value is PresenceSurface {
  return typeof value === 'string' && SURFACES.has(value as PresenceSurface)
}

export function isPresenceVisibility(value: unknown): value is PresenceVisibility {
  return typeof value === 'string' && VISIBILITIES.has(value as PresenceVisibility)
}

export class PresenceRegistry {
  readonly #byId = new Map<string, ClientPresence>()

  upsert(presence: Omit<ClientPresence, 'lastSeenAt'> & { lastSeenAt?: number }): void {
    const lastSeenAt = presence.lastSeenAt ?? Date.now()
    const previous = this.#byId.get(presence.clientId)
    const lastFocusedAt = presence.visibility === 'focused'
      ? lastSeenAt
      : presence.lastFocusedAt ?? previous?.lastFocusedAt
    this.#byId.set(presence.clientId, {
      clientId: presence.clientId,
      surface: presence.surface,
      visibility: presence.visibility,
      lastSeenAt,
      ...(presence.sessionPath ? { sessionPath: presence.sessionPath } : {}),
      ...(lastFocusedAt === undefined ? {} : { lastFocusedAt }),
    })
  }

  remove(clientId: string): void {
    this.#byId.delete(clientId)
  }

  get(clientId: string): ClientPresence | undefined {
    return this.#byId.get(clientId)
  }

  list(now = Date.now()): ClientPresence[] {
    return [...this.#byId.values()].filter((client) => now - client.lastSeenAt <= PRESENCE_STALE_MS)
  }
}

export function isWatchingSession(client: ClientPresence, sessionPath: string | undefined, now = Date.now()): boolean {
  const onSession = !sessionPath || !client.sessionPath || client.sessionPath === sessionPath
  if (!onSession) return false
  if (client.visibility === 'focused') return true
  return (client.lastFocusedAt ?? 0) > 0 && now - (client.lastFocusedAt ?? 0) < FOCUS_GRACE_MS
}

export function isForegroundClient(client: ClientPresence, now = Date.now()): boolean {
  if (client.visibility === 'focused' || client.visibility === 'visible') return true
  return (client.lastFocusedAt ?? 0) > 0 && now - (client.lastFocusedAt ?? 0) < FOCUS_GRACE_MS
}

export function routeAttention(event: AttentionTarget, clients: readonly ClientPresence[], now = Date.now()): string[] {
  const live = clients.filter((client) => now - client.lastSeenAt <= PRESENCE_STALE_MS)
  if (live.length === 0) return []
  if (live.some((client) => isWatchingSession(client, event.sessionPath, now))) return []
  if (live.some((client) => isForegroundClient(client, now))) return []
  const ranked = [...live].sort((left, right) => {
    const visibility = visibilityScore(left) - visibilityScore(right)
    if (visibility !== 0) return visibility
    return right.lastSeenAt - left.lastSeenAt
  })
  const best = ranked[0]
  return best ? [best.clientId] : []
}

function visibilityScore(client: ClientPresence): number {
  if (client.visibility === 'hidden') return 0
  if (client.visibility === 'visible') return 1
  return 2
}
