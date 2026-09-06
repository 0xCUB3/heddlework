import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'

export const TAILSCALE_HTTPS_PORTS = [443, 8443, 10_000] as const
export type TailscaleHttpsPort = (typeof TAILSCALE_HTTPS_PORTS)[number]

const DEFAULT_TIMEOUT_MS = 8_000
const STATUS_MAX_BYTES = 1_000_000
const SERVE_MAX_BYTES = 256_000

export interface TailscaleRunResult {
  code: number
  stdout: string
  stderr: string
}

export interface TailscaleNodeStatus {
  backendState: string
  httpsCapability: boolean
  certDomains: string[]
  magicDnsEnabled: boolean
  online: boolean
  health: string[]
  authUrl?: string
  dnsName?: string
  magicDnsSuffix?: string
}

export interface ServeHandler {
  proxy?: string
  path?: string
  text?: string
}

export interface ServeTcp {
  https?: boolean
  http?: boolean
  tcpForward?: string
}

export interface ServeWeb {
  handlers: Record<string, ServeHandler>
}

export interface ServeConfig {
  tcp: Record<string, ServeTcp>
  web: Record<string, ServeWeb>
  allowFunnel: Record<string, boolean>
}

export interface TailscaleCli {
  findBinary(): string | undefined
  status(binary: string): Promise<TailscaleNodeStatus>
  serveStatus(binary: string): Promise<ServeConfig>
  serveHttps(binary: string, port: TailscaleHttpsPort, target: string): Promise<string>
  serveHttpsOff(binary: string, port: TailscaleHttpsPort): Promise<void>
}

export type TailscaleRunner = (binary: string, args: string[], options?: { timeoutMs?: number; maxBytes?: number }) => Promise<TailscaleRunResult>

export function isTailscaleHttpsPort(value: unknown): value is TailscaleHttpsPort {
  return value === 443 || value === 8443 || value === 10_000
}

export function redactSecrets(text: string): string {
  return text.replace(/([?&]token=)[^&\s]+/gi, '$1***')
}

export function normalizeDnsName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\.+$/, '')
  return trimmed ? trimmed.toLowerCase() : undefined
}

export function findTailscaleBinary(environment: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = existsSync): string | undefined {
  const override = environment.HEDDLEWORK_TAILSCALE?.trim()
  if (override) return exists(override) ? override : undefined
  const names = process.platform === 'win32' ? ['tailscale.exe'] : ['tailscale']
  const extras = process.platform === 'darwin'
    ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Tailscale\\tailscale.exe']
      : ['/usr/bin/tailscale', '/usr/sbin/tailscale', '/usr/local/bin/tailscale']
  const pathEntries = (environment.PATH ?? environment.Path ?? '').split(delimiter).filter(Boolean)
  const candidates = [
    ...pathEntries.flatMap((directory) => names.map((name) => `${directory.replace(/[/\\]+$/, '')}${process.platform === 'win32' ? '\\' : '/'}${name}`)),
    ...extras,
  ]
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue
    seen.add(candidate)
    if (exists(candidate)) return candidate
  }
  return undefined
}

export function parseNodeStatus(raw: string): TailscaleNodeStatus {
  const value = parseJsonObject(raw, 'Tailscale status')
  const self = isRecord(value.Self) ? value.Self : {}
  const tailnet = isRecord(value.CurrentTailnet) ? value.CurrentTailnet : {}
  const capMap = isRecord(self.CapMap) ? self.CapMap : undefined
  const capabilities = Array.isArray(self.Capabilities) ? self.Capabilities.filter((item): item is string => typeof item === 'string') : []
  const httpsCapability = capMap ? Object.prototype.hasOwnProperty.call(capMap, 'https') : capabilities.includes('https')
  const certDomains = Array.isArray(value.CertDomains) ? value.CertDomains.filter((item): item is string => typeof item === 'string') : []
  const dnsName = normalizeDnsName(typeof self.DNSName === 'string' ? self.DNSName : certDomains[0])
  const authUrl = typeof value.AuthURL === 'string' && value.AuthURL.trim() ? value.AuthURL.trim() : undefined
  const health = Array.isArray(value.Health) ? value.Health.filter((item): item is string => typeof item === 'string') : []
  return {
    backendState: typeof value.BackendState === 'string' ? value.BackendState : 'unknown',
    httpsCapability,
    certDomains: certDomains.map((domain) => domain.replace(/\.+$/, '')),
    magicDnsEnabled: tailnet.MagicDNSEnabled === true,
    online: self.Online === true,
    health,
    ...(authUrl ? { authUrl } : {}),
    ...(dnsName ? { dnsName } : {}),
    ...(typeof tailnet.MagicDNSSuffix === 'string' ? { magicDnsSuffix: tailnet.MagicDNSSuffix.replace(/\.+$/, '') } : {}),
  }
}

export function parseServeConfig(raw: string): ServeConfig {
  const trimmed = raw.trim()
  if (!trimmed || /^no serve config/i.test(trimmed)) return emptyServeConfig()
  const value = parseJsonObject(trimmed, 'Tailscale Serve status')
  const tcp: Record<string, ServeTcp> = {}
  if (isRecord(value.TCP)) {
    for (const [port, entry] of Object.entries(value.TCP)) {
      if (!isRecord(entry)) continue
      tcp[port] = {
        ...(entry.HTTPS === true ? { https: true } : {}),
        ...(entry.HTTP === true ? { http: true } : {}),
        ...(typeof entry.TCPForward === 'string' ? { tcpForward: entry.TCPForward } : {}),
      }
    }
  }
  const web: Record<string, ServeWeb> = {}
  if (isRecord(value.Web)) {
    for (const [hostPort, entry] of Object.entries(value.Web)) {
      if (!isRecord(entry) || !isRecord(entry.Handlers)) continue
      const handlers: Record<string, ServeHandler> = {}
      for (const [path, handler] of Object.entries(entry.Handlers)) {
        if (!isRecord(handler)) continue
        handlers[path] = {
          ...(typeof handler.Proxy === 'string' ? { proxy: handler.Proxy } : {}),
          ...(typeof handler.Path === 'string' ? { path: handler.Path } : {}),
          ...(typeof handler.Text === 'string' ? { text: handler.Text } : {}),
        }
      }
      web[hostPort] = { handlers }
    }
  }
  const allowFunnel: Record<string, boolean> = {}
  if (isRecord(value.AllowFunnel)) {
    for (const [hostPort, enabled] of Object.entries(value.AllowFunnel)) {
      if (enabled === true) allowFunnel[hostPort] = true
    }
  }
  return { tcp, web, allowFunnel }
}

export function emptyServeConfig(): ServeConfig {
  return { tcp: {}, web: {}, allowFunnel: {} }
}

export function serveHostPort(dnsName: string, port: TailscaleHttpsPort): string {
  return `${normalizeDnsName(dnsName) ?? dnsName}:${port}`
}

export function handlerAt(config: ServeConfig, dnsName: string, port: TailscaleHttpsPort, path = '/'): ServeHandler | undefined {
  return config.web[serveHostPort(dnsName, port)]?.handlers[path]
}

export function tcpAt(config: ServeConfig, port: TailscaleHttpsPort): ServeTcp | undefined {
  return config.tcp[String(port)]
}

export function funnelAt(config: ServeConfig, dnsName: string, port: TailscaleHttpsPort): boolean {
  return config.allowFunnel[serveHostPort(dnsName, port)] === true
}

export function createTailscaleCli(run: TailscaleRunner = runTailscaleBinary): TailscaleCli {
  return {
    findBinary: () => findTailscaleBinary(),
    async status(binary) {
      const result = await runChecked(run, binary, ['status', '--json'], STATUS_MAX_BYTES)
      return parseNodeStatus(result.stdout)
    },
    async serveStatus(binary) {
      const result = await runChecked(run, binary, ['serve', 'status', '--json'], SERVE_MAX_BYTES)
      return parseServeConfig(result.stdout || result.stderr)
    },
    async serveHttps(binary, port, target) {
      const result = await runChecked(run, binary, ['serve', '--bg', '--yes', `--https=${port}`, target], SERVE_MAX_BYTES)
      return redactSecrets(`${result.stdout}\n${result.stderr}`.trim())
    },
    async serveHttpsOff(binary, port) {
      await runChecked(run, binary, ['serve', `--https=${port}`, 'off'], SERVE_MAX_BYTES)
    },
  }
}

async function runChecked(run: TailscaleRunner, binary: string, args: string[], maxBytes: number): Promise<TailscaleRunResult> {
  const result = await run(binary, args, { maxBytes, timeoutMs: DEFAULT_TIMEOUT_MS })
  if (result.code !== 0) {
    const detail = redactSecrets((result.stderr || result.stdout).trim()) || `exit ${result.code}`
    throw new Error(`tailscale ${args.join(' ')} failed: ${detail}`)
  }
  return result
}

export async function runTailscaleBinary(binary: string, args: string[], options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<TailscaleRunResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? STATUS_MAX_BYTES
  const child = Bun.spawn([binary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  })
  const timer = setTimeout(() => child.kill(), timeoutMs)
  try {
    const [stdout, stderr] = await Promise.all([readBounded(child.stdout, maxBytes), readBounded(child.stderr, maxBytes)])
    const code = await child.exited
    return { code, stdout, stderr }
  } finally {
    clearTimeout(timer)
  }
}

async function readBounded(stream: ReadableStream<Uint8Array> | undefined, maxBytes: number): Promise<string> {
  if (!stream) return ''
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    total += value.byteLength
    if (total > maxBytes) {
      try { await reader.cancel() } catch { /* already closed */ }
      throw new Error(`Tailscale output exceeded ${maxBytes} bytes.`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function parseJsonObject(raw: string, label: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error(`${label} was not JSON.`)
  }
  if (!isRecord(value)) throw new Error(`${label} was not an object.`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
