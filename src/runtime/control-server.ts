import { timingSafeEqualToken } from '../host/token.ts'
import type { RemoteAccessMode } from '../host/remote-access.ts'
import type { RuntimeStatus } from './bootstrap.ts'
import {
  isRuntimeSettingsResponse,
  nextRuntimeControlRequestId,
  type RuntimeSettingsRequest,
  type RuntimeSettingsResponse,
  type RuntimeSettingsStatus,
} from './control-protocol.ts'

export interface RuntimeControlServerOptions {
  hostname?: string | undefined
  port?: number | undefined
  token: string
  instanceId: string
  protocol: number
  version: string
  isBusy(): boolean
  settingsStatus(): RuntimeSettingsStatus
  applySettings(request: RuntimeSettingsRequest): Promise<RuntimeSettingsStatus>
  upgrade?(): Promise<void>
  stop?(): Promise<void>
}

export interface RuntimeControlServer {
  readonly url: string
  readonly port: number
  close(): Promise<void>
}

function authorized(request: Request, token: string): boolean {
  const header = request.headers.get('authorization')
  const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
  const url = new URL(request.url)
  return timingSafeEqualToken(token, url.searchParams.get('token')) || timingSafeEqualToken(token, bearer)
}

function isRemoteAccessMode(value: unknown): value is RemoteAccessMode {
  return value === 'off' || value === 'local' || value === 'network'
}

function isSettingsRequest(value: unknown): value is RuntimeSettingsRequest {
  if (!value || typeof value !== 'object') return false
  const record = value as { op?: unknown; requestId?: unknown }
  if (typeof record.requestId !== 'string' || !record.requestId.trim()) return false
  switch (record.op) {
    case 'setRemoteAccessMode':
      return isRemoteAccessMode((record as { mode?: unknown }).mode)
    case 'setTailnetEnabled':
      return typeof (record as { enabled?: unknown }).enabled === 'boolean'
    case 'setTailnetHttpsPort':
      return typeof (record as { port?: unknown }).port === 'number'
    case 'refreshTailnet':
      return true
    default:
      return false
  }
}

function okResponse(requestId: string, status: RuntimeSettingsStatus): Response {
  const payload: RuntimeSettingsResponse = { requestId, ok: true, status }
  return Response.json(payload)
}

function errorResponse(requestId: string, error: string, statusCode = 400): Response {
  const payload: RuntimeSettingsResponse = { requestId, ok: false, error }
  return Response.json(payload, { status: statusCode })
}

export function createRuntimeControlServer(options: RuntimeControlServerOptions): RuntimeControlServer {
  const hostname = options.hostname ?? '127.0.0.1'
  const server = Bun.serve({
    hostname,
    port: options.port ?? 0,
    async fetch(request) {
      if (!authorized(request, options.token)) return new Response('Unauthorized', { status: 401 })
      const url = new URL(request.url)
      if (url.pathname === '/status' && request.method === 'GET') {
        const payload: RuntimeStatus = {
          instanceId: options.instanceId,
          busy: options.isBusy(),
          protocol: options.protocol,
          version: options.version,
        }
        return Response.json(payload)
      }
      if (url.pathname === '/stop' && request.method === 'POST') {
        if (!options.stop) return new Response('Stop unavailable', { status: 501 })
        await options.stop()
        return Response.json({ ok: true })
      }
      if (url.pathname === '/upgrade' && request.method === 'POST') {
        if (options.isBusy()) return new Response('Agents are busy', { status: 409 })
        if (!options.upgrade) return new Response('Upgrade unavailable', { status: 501 })
        try {
          await options.upgrade()
          return Response.json({ ok: true })
        } catch (cause) {
          return new Response(cause instanceof Error ? cause.message : String(cause), { status: 500 })
        }
      }
      if (url.pathname === '/settings/status' && request.method === 'GET') {
        return Response.json(options.settingsStatus())
      }
      if (url.pathname === '/settings/remote' && request.method === 'POST') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('Malformed JSON', { status: 400 })
        }
        if (isSettingsRequest(body)) {
          try {
            const status = await options.applySettings(body)
            return okResponse(body.requestId, status)
          } catch (cause) {
            return errorResponse(body.requestId, cause instanceof Error ? cause.message : String(cause), 500)
          }
        }
        if (!body || typeof body !== 'object') return new Response('Expected settings object', { status: 400 })
        const record = body as { mode?: unknown; requestId?: unknown }
        if (!isRemoteAccessMode(record.mode)) return new Response('Expected remote access mode', { status: 400 })
        const requestId = typeof record.requestId === 'string' && record.requestId.trim()
          ? record.requestId
          : nextRuntimeControlRequestId()
        try {
          const status = await options.applySettings({ requestId, op: 'setRemoteAccessMode', mode: record.mode })
          return okResponse(requestId, status)
        } catch (cause) {
          return errorResponse(requestId, cause instanceof Error ? cause.message : String(cause), 500)
        }
      }
      if (url.pathname === '/settings/tailnet' && request.method === 'POST') {
        let body: unknown
        try {
          body = await request.json()
        } catch {
          return new Response('Malformed JSON', { status: 400 })
        }
        if (!body || typeof body !== 'object') return new Response('Expected settings object', { status: 400 })
        const record = body as { enabled?: unknown; requestId?: unknown }
        if (typeof record.enabled !== 'boolean') return new Response('Expected enabled boolean', { status: 400 })
        const requestId = typeof record.requestId === 'string' && record.requestId.trim()
          ? record.requestId
          : nextRuntimeControlRequestId()
        try {
          const status = await options.applySettings({ requestId, op: 'setTailnetEnabled', enabled: record.enabled })
          return okResponse(requestId, status)
        } catch (cause) {
          return errorResponse(requestId, cause instanceof Error ? cause.message : String(cause), 500)
        }
      }
      return new Response('Not found', { status: 404 })
    },
  })

  const port = server.port ?? options.port ?? 0
  const displayHost = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname
  return {
    url: `http://${displayHost}:${port}`,
    port,
    close: async () => { await server.stop(true) },
  }
}

export function parseSettingsResponse(payload: unknown): RuntimeSettingsResponse | undefined {
  return isRuntimeSettingsResponse(payload) ? payload : undefined
}


