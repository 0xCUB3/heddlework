import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  funnelAt,
  handlerAt,
  isTailscaleHttpsPort,
  normalizeDnsName,
  redactSecrets,
  serveHostPort,
  tcpAt,
  TAILSCALE_HTTPS_PORTS,
  type ServeConfig,
  type TailscaleHttpsPort,
  type TailscaleNodeStatus,
} from './tailscale-cli.ts'

export type TailnetServeStatus =
  | 'notInstalled'
  | 'stopped'
  | 'needsLogin'
  | 'needsHttps'
  | 'needsHost'
  | 'idle'
  | 'conflict'
  | 'starting'
  | 'stopping'
  | 'ready'
  | 'error'

export interface TailnetServeOwnership {
  dnsName: string
  httpsPort: TailscaleHttpsPort
  path: '/'
  proxy: string
}

export interface TailnetServePreference {
  enabled: boolean
  httpsPort?: TailscaleHttpsPort
  ownership?: TailnetServeOwnership
}

export interface TailnetServeConflict {
  port: TailscaleHttpsPort
  summary: string
}

export interface TailnetServeSnapshot {
  status: TailnetServeStatus
  enabled: boolean
  busy: boolean
  availablePorts: TailscaleHttpsPort[]
  conflicts: TailnetServeConflict[]
  message: string
  magicDnsEnabled: boolean
  dnsName?: string
  httpsPort?: TailscaleHttpsPort
  url?: string
  binaryPath?: string
  backendState?: string
  approvalUrl?: string
  error?: string
}

export function localProxyUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function tailnetHostUrl(dnsName: string, httpsPort: TailscaleHttpsPort): string {
  const host = normalizeDnsName(dnsName) ?? dnsName
  return httpsPort === 443 ? `https://${host}` : `https://${host}:${httpsPort}`
}

export function tailnetConnectUrl(dnsName: string, httpsPort: TailscaleHttpsPort, token: string): string {
  return `${tailnetHostUrl(dnsName, httpsPort)}/?token=${encodeURIComponent(token)}`
}

export function parseTailnetServePreference(value: unknown): TailnetServePreference {
  if (!value || typeof value !== 'object') return { enabled: false }
  const record = value as { enabled?: unknown; httpsPort?: unknown; ownership?: unknown }
  const httpsPort = isTailscaleHttpsPort(record.httpsPort) ? record.httpsPort : undefined
  const ownership = parseOwnership(record.ownership)
  return {
    enabled: record.enabled === true,
    ...(httpsPort ? { httpsPort } : {}),
    ...(ownership ? { ownership } : {}),
  }
}

export function readTailnetServePreference(path: string | false): TailnetServePreference {
  if (!path) return { enabled: false }
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { tailscaleServe?: unknown }
    return parseTailnetServePreference(value.tailscaleServe)
  } catch {
    return { enabled: false }
  }
}

export function writeTailnetServePreference(preference: TailnetServePreference, path: string | false): void {
  if (!path) return
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    existing = {}
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...existing, tailscaleServe: preference }, null, 2)}\n`, 'utf8')
}

export function occupancySummary(config: ServeConfig, dnsName: string, port: TailscaleHttpsPort): string | undefined {
  if (funnelAt(config, dnsName, port)) return `port ${port} is published with Tailscale Funnel`
  const handler = handlerAt(config, dnsName, port)
  if (handler?.proxy) return `port ${port} already proxies ${redactSecrets(handler.proxy)}`
  if (handler?.path) return `port ${port} already serves a file path`
  if (handler?.text) return `port ${port} already serves text`
  if (handler) return `port ${port} already has a Serve handler`
  const tcp = tcpAt(config, port)
  if (tcp?.tcpForward) return `port ${port} already forwards TCP to ${tcp.tcpForward}`
  if (tcp?.https || tcp?.http) return `port ${port} is already reserved for Serve`
  const web = config.web[serveHostPort(dnsName, port)]
  if (web && Object.keys(web.handlers).length > 0) return `port ${port} already has Serve paths`
  return undefined
}

export function isPortFree(config: ServeConfig, dnsName: string, port: TailscaleHttpsPort): boolean {
  return occupancySummary(config, dnsName, port) === undefined
}

export function ownershipMatches(config: ServeConfig, ownership: TailnetServeOwnership): boolean {
  if (funnelAt(config, ownership.dnsName, ownership.httpsPort)) return false
  const tcp = tcpAt(config, ownership.httpsPort)
  if (!tcp?.https) return false
  const handler = handlerAt(config, ownership.dnsName, ownership.httpsPort, ownership.path)
  return handler?.proxy === ownership.proxy
}

export function chooseHttpsPort(options: {
  config: ServeConfig
  dnsName: string
  preferred?: TailscaleHttpsPort
  ownership?: TailnetServeOwnership
}): { port: TailscaleHttpsPort; available: TailscaleHttpsPort[]; conflicts: TailnetServeConflict[] } | { available: TailscaleHttpsPort[]; conflicts: TailnetServeConflict[] } {
  const conflicts: TailnetServeConflict[] = []
  const available: TailscaleHttpsPort[] = []
  for (const port of TAILSCALE_HTTPS_PORTS) {
    const owned = options.ownership && options.ownership.httpsPort === port && ownershipMatches(options.config, options.ownership)
    if (owned || isPortFree(options.config, options.dnsName, port)) {
      available.push(port)
      continue
    }
    conflicts.push({ port, summary: occupancySummary(options.config, options.dnsName, port) ?? `port ${port} is in use` })
  }
  const preferred = options.preferred
  if (preferred && available.includes(preferred)) return { port: preferred, available, conflicts }
  if (preferred && !available.includes(preferred)) return { available, conflicts }
  const ownedPort = options.ownership && available.includes(options.ownership.httpsPort) ? options.ownership.httpsPort : undefined
  const port = ownedPort ?? available[0]
  if (port === undefined) return { available, conflicts }
  return { port, available, conflicts }
}

export function inspectTailnetServe(options: {
  binaryPath?: string
  status?: TailscaleNodeStatus
  config?: ServeConfig
  preference: TailnetServePreference
  hostPort?: number | undefined
  busy?: boolean
  phase?: 'starting' | 'stopping'
  error?: string
}): TailnetServeSnapshot {
  const busy = options.busy === true
  const preference = options.preference
  const base = {
    enabled: preference.enabled,
    busy,
    availablePorts: [] as TailscaleHttpsPort[],
    conflicts: [] as TailnetServeConflict[],
    magicDnsEnabled: options.status?.magicDnsEnabled === true,
    ...(options.binaryPath ? { binaryPath: options.binaryPath } : {}),
    ...(options.status ? { backendState: options.status.backendState } : {}),
    ...(preference.httpsPort ? { httpsPort: preference.httpsPort } : {}),
    ...(options.status?.dnsName ? { dnsName: options.status.dnsName } : {}),
    ...(options.status?.authUrl ? { approvalUrl: options.status.authUrl } : {}),
  }

  if (options.phase === 'starting') {
    return { ...base, status: 'starting', message: 'Starting Tailscale Serve…' }
  }
  if (options.phase === 'stopping') {
    return { ...base, status: 'stopping', message: "Stopping Heddlework's Tailscale Serve endpoint…" }
  }
  if (!options.binaryPath) {
    return { ...base, status: 'notInstalled', message: 'Tailscale is not installed on this computer. Install Tailscale, sign in, then try Setup again.' }
  }
  if (!options.status) {
    return { ...base, status: 'error', message: 'Could not read Tailscale status.', ...(options.error ? { error: options.error } : {}) }
  }
  const backend = options.status.backendState
  if (backend === 'NeedsLogin' || backend === 'NeedsMachineAuth') {
    return {
      ...base,
      status: 'needsLogin',
      message: 'Tailscale is signed out. Sign in with the Tailscale app, then try Setup again.',
    }
  }
  if (backend !== 'Running') {
    return {
      ...base,
      status: 'stopped',
      message: 'Tailscale is installed but not running. Open the Tailscale app and sign in, then try Setup again.',
    }
  }
  const dnsName = options.status.dnsName ?? normalizeDnsName(options.status.certDomains[0])
  if (!options.status.httpsCapability || !dnsName || options.status.certDomains.length === 0) {
    return {
      ...base,
      ...(dnsName ? { dnsName } : {}),
      status: 'needsHttps',
      message: 'This tailnet has not issued HTTPS certificates yet. In the Tailscale admin console, enable HTTPS, wait for the certificate, then try Setup again.',
    }
  }
  const config = options.config ?? { tcp: {}, web: {}, allowFunnel: {} }
  const choice = chooseHttpsPort({
    config,
    dnsName,
    ...(preference.httpsPort ? { preferred: preference.httpsPort } : {}),
    ...(preference.ownership ? { ownership: preference.ownership } : {}),
  })
  const snapshot = {
    ...base,
    dnsName,
    availablePorts: choice.available,
    conflicts: choice.conflicts,
    magicDnsEnabled: options.status.magicDnsEnabled,
  }
  if (options.error) {
    return { ...snapshot, status: 'error', message: options.error, error: options.error, ...('port' in choice ? { httpsPort: choice.port, url: tailnetHostUrl(dnsName, choice.port) } : {}) }
  }
  if (!('port' in choice)) {
    const detail = choice.conflicts.map((item) => item.summary).join('. ')
    return {
      ...snapshot,
      status: 'conflict',
      message: detail
        ? `${detail}. Heddlework will not replace those endpoints.`
        : 'Every Tailscale HTTPS port is already serving something else. Heddlework will not replace those endpoints.',
    }
  }
  const port = choice.port
  const url = tailnetHostUrl(dnsName, port)
  const owned = preference.ownership && ownershipMatches(config, preference.ownership)
  if (preference.enabled && options.hostPort === undefined) {
    return {
      ...snapshot,
      httpsPort: port,
      url,
      status: 'needsHost',
      message: 'Turn on Remote access so Tailscale Serve has a local workbench to proxy.',
    }
  }
  if (owned && preference.enabled) {
    const magic = options.status.magicDnsEnabled ? '' : ' MagicDNS is off, so other devices need this tailnet name in their resolver.'
    return {
      ...snapshot,
      httpsPort: port,
      url,
      status: 'ready',
      message: `Available on your tailnet at ${url}.${magic}`,
    }
  }
  if (preference.enabled && preference.httpsPort && !choice.available.includes(preference.httpsPort)) {
    const taken = choice.conflicts.find((item) => item.port === preference.httpsPort)
    return {
      ...snapshot,
      httpsPort: preference.httpsPort,
      status: 'conflict',
      message: taken
        ? `${taken.summary}. Pick another HTTPS port or stop that endpoint in Tailscale, then try Setup again.`
        : `Port ${preference.httpsPort} is already serving something else. Heddlework will not replace it.`,
    }
  }
  if (choice.conflicts.length > 0 && port !== 443) {
    return {
      ...snapshot,
      httpsPort: port,
      url,
      status: 'idle',
      message: `${choice.conflicts.map((item) => item.summary).join('. ')}. Setup will use ${url} and leave the other endpoints alone.`,
    }
  }
  return {
    ...snapshot,
    httpsPort: port,
    url,
    status: 'idle',
    message: 'Private HTTPS is off. Setup asks Tailscale Serve to proxy this workbench to your MagicDNS name. Other Serve endpoints are left alone.',
  }
}

export function ownedEndpoint(dnsName: string, httpsPort: TailscaleHttpsPort, hostPort: number): TailnetServeOwnership {
  return { dnsName, httpsPort, path: '/', proxy: localProxyUrl(hostPort) }
}

function parseOwnership(value: unknown): TailnetServeOwnership | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as { dnsName?: unknown; httpsPort?: unknown; path?: unknown; proxy?: unknown }
  if (typeof record.dnsName !== 'string' || !isTailscaleHttpsPort(record.httpsPort) || typeof record.proxy !== 'string') return undefined
  const dnsName = normalizeDnsName(record.dnsName)
  if (!dnsName || !/^https?:\/\/127\.0\.0\.1:\d+$/.test(record.proxy)) return undefined
  return { dnsName, httpsPort: record.httpsPort, path: '/', proxy: record.proxy }
}
