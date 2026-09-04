import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type { FlowRuntime } from '../flows/runtime.ts'
import {
  applyWorkbenchCommand,
  diffSnapshots,
  isPatchEmpty,
  isWorkbenchCommand,
  parseClientMessage,
  PROTOCOL_VERSION,
  serializeSnapshot,
  type ServerMessage,
  type WorkbenchSnapshot,
} from '../protocol/index.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { timingSafeEqualToken } from './token.ts'

export interface WorkspaceHostOptions {
  controller: WorkbenchController
  flows: FlowRuntime
  workspacePath: string
  port: number
  hostname?: string | undefined
  token: string
  staticRoot?: string | undefined
}

export interface WorkspaceHost {
  readonly url: string
  readonly port: number
  readonly hostname: string
  readonly token: string
  readonly workspacePath: string
  connectionCount(): number
  close(): Promise<void>
}

interface SocketData {
  lastSnapshot: WorkbenchSnapshot | undefined
  scheduled: boolean
}

export const DEFAULT_HOST_PORT = 4817
export const DEFAULT_HOST_BIND = '127.0.0.1'

export function createWorkspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
  const hostname = options.hostname ?? DEFAULT_HOST_BIND
  const staticRoot = options.staticRoot && existsSync(options.staticRoot) ? resolve(options.staticRoot) : undefined
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>()

  const server = Bun.serve<SocketData>({
    hostname,
    port: options.port,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === '/ws') {
        if (!authorized(request, url, options.token)) return new Response('Unauthorized', { status: 401 })
        const upgraded = bunServer.upgrade(request, { data: { lastSnapshot: undefined, scheduled: false } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 426 })
      }
      if (url.pathname === '/health') {
        return Response.json({ ok: true, protocol: PROTOCOL_VERSION, workspacePath: options.workspacePath })
      }
      if (staticRoot && request.method === 'GET') return serveStatic(staticRoot, url.pathname)
      return new Response('Heddlework workspace host', { status: 404 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
        const snapshot = serializeSnapshot(options.controller.getSnapshot())
        socket.data.lastSnapshot = snapshot
        send(socket, { kind: 'welcome', protocol: PROTOCOL_VERSION, workspacePath: options.workspacePath, snapshot, flows: options.flows.getSnapshot() })
      },
      close(socket) {
        sockets.delete(socket)
      },
      async message(socket, raw) {
        const message = parseClientMessage(typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8'))
        if (!message) {
          send(socket, { kind: 'error', message: 'Malformed client message' })
          return
        }
        if (message.kind === 'ping') {
          send(socket, { kind: 'pong' })
          return
        }
        if (message.kind === 'hello') {
          if (message.protocol !== PROTOCOL_VERSION) send(socket, { kind: 'error', message: `Unsupported protocol ${message.protocol}; host speaks ${PROTOCOL_VERSION}` })
          return
        }
        if (!isWorkbenchCommand(message.command)) {
          send(socket, { kind: 'result', id: message.id, ok: false, error: 'Unknown workbench command' })
          return
        }
        try {
          await applyWorkbenchCommand(options.controller, message.command)
          send(socket, { kind: 'result', id: message.id, ok: true })
        } catch (error) {
          send(socket, { kind: 'result', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  })

  const publish = (): void => {
    for (const socket of sockets) {
      if (socket.data.scheduled) continue
      socket.data.scheduled = true
      queueMicrotask(() => {
        socket.data.scheduled = false
        if (!sockets.has(socket)) return
        const next = serializeSnapshot(options.controller.getSnapshot())
        const patch = diffSnapshots(socket.data.lastSnapshot, next)
        socket.data.lastSnapshot = next
        if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
      })
    }
  }
  const unsubscribeController = options.controller.subscribe(publish)
  const unsubscribeFlows = options.flows.subscribe(() => {
    const snapshot = options.flows.getSnapshot()
    for (const socket of sockets) send(socket, { kind: 'flows', snapshot })
  })

  const port = server.port ?? options.port
  const displayHost = hostname === '0.0.0.0' || hostname === '::' ? '127.0.0.1' : hostname
  let closed = false
  return {
    url: `http://${displayHost}:${port}`,
    port,
    hostname,
    token: options.token,
    workspacePath: options.workspacePath,
    connectionCount: () => sockets.size,
    async close() {
      if (closed) return
      closed = true
      unsubscribeController()
      unsubscribeFlows()
      for (const socket of sockets) socket.close(1001, 'Host shutting down')
      sockets.clear()
      await server.stop(true)
    },
  }
}

export function hostConnectUrl(host: Pick<WorkspaceHost, 'url' | 'token'>): string {
  return `${host.url}/?token=${encodeURIComponent(host.token)}`
}

function authorized(request: Request, url: URL, token: string): boolean {
  const header = request.headers.get('authorization')
  const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
  return timingSafeEqualToken(token, url.searchParams.get('token')) || timingSafeEqualToken(token, bearer)
}

function send(socket: Bun.ServerWebSocket<SocketData>, message: ServerMessage): void {
  try {
    socket.send(JSON.stringify(message))
  } catch {
    // A socket closing mid-send is dropped by the close handler.
  }
}

function serveStatic(root: string, pathname: string): Response {
  const relative = normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
  const candidate = resolve(root, relative || 'index.html')
  if (!candidate.startsWith(root)) return new Response('Forbidden', { status: 403 })
  const target = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, 'index.html')
  if (!existsSync(target)) return new Response('Not found', { status: 404 })
  const headers: Record<string, string> = target.endsWith('index.html') ? { 'cache-control': 'no-cache' } : {}
  if (target.endsWith('.webmanifest')) headers['content-type'] = 'application/manifest+json'
  return new Response(Bun.file(target), { headers })
}
