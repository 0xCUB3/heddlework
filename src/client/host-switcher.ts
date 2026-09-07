// Which machine the workbench is showing, and how to move to another one. Browser-safe.
//
// Every client (GPUix desktop, DOM web, SwiftUI) renders the same picture from this surface: a current host with a
// live status, the hosts this device has connected to before, and a way to connect or go back to the local runtime.

import type { HostIdentity } from '../protocol/host-identity.ts'
import type { SavedHost } from './saved-hosts.ts'

export type HostLinkStatus = 'connecting' | 'open' | 'closed'

export interface CurrentHost {
  // 'local' is the runtime on this machine; 'remote' is another computer's host reached over its connect link.
  origin: 'local' | 'remote'
  // Identity from the last welcome; undefined until the first welcome or when talking to an older host.
  identity: HostIdentity | undefined
  // The URL the socket is using right now, for diagnostics and the settings list.
  url: string
  status: HostLinkStatus
  lastError?: string | undefined
  // Saved record this connection came from, when it did.
  savedId?: string | undefined
}

export interface HostSwitcherSnapshot {
  current: CurrentHost
  saved: readonly SavedHost[]
  // True while a switch is in flight so pickers disable themselves.
  busy: boolean
  // Desktop has a local runtime to fall back to; web and iOS do not.
  canUseLocal: boolean
}

export interface HostSwitcherSurface {
  subscribe(listener: () => void): () => void
  getSnapshot(): HostSwitcherSnapshot
  // Connect to another computer by its connect link (http://host:port/?token=…) or a saved host id.
  connect(target: { link: string } | { savedId: string }): Promise<void>
  // Return to the runtime on this machine. Rejects when canUseLocal is false.
  useLocal(): Promise<void>
  forget(savedId: string): void
  rename(savedId: string, name: string): void
}

// Parses the connect link printed by `bun run host` or shown in Settings > Remote access. Accepts ws/wss too and the
// heddlework://connect?url=… deep link. Returns the http(s) origin plus path and the token, or undefined.
export function parseConnectLink(raw: string): { url: string; token: string } | undefined {
  const text = raw.trim()
  if (!text) return undefined
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol === 'heddlework:') {
    const inner = url.searchParams.get('url')
    return inner ? parseConnectLink(inner) : undefined
  }
  const scheme = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol
  if (scheme !== 'http:' && scheme !== 'https:') return undefined
  const token = url.searchParams.get('token') ?? ''
  if (!token) return undefined
  let path = url.pathname
  if (path.endsWith('/ws')) path = path.slice(0, -3)
  if (path.endsWith('/')) path = path.slice(0, -1)
  return { url: `${scheme}//${url.host}${path}`, token }
}
