// Connect-link helpers from src/host/server.ts that the settings view needs, without the Node HTTP host.

export interface RemoteConnectUrl { kind: string; url: string }

export function withConnectToken(url: string, token: string): string {
  return `${url.replace(/\/+$/, '')}/?token=${encodeURIComponent(token)}`
}
export function hostConnectUrl(host: { url: string; token: string }): string {
  return withConnectToken(host.url, host.token)
}
export function preferredPairingLink(host: { token: string; url: string }, serveUrl?: string): string | undefined {
  return serveUrl ? withConnectToken(serveUrl, host.token) : undefined
}
export function remoteConnectUrls(): RemoteConnectUrl[] { return [] }
