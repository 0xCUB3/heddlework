import type { BrowserIntegrationService } from '../browser/integrations.ts'
import { existsSync, statSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type { FlowRuntime } from '../flows/runtime.ts'
import type { SleepPreventionService } from '../power/service.ts'
import {
  diffSnapshots,
  encodeFrames,
  isPatchEmpty,
  isWorkbenchCommand,
  MAX_ASSEMBLED_BYTES,
  parseClientMessage,
  PROTOCOL_VERSION,
  serializeSnapshot,
  utf8ByteLength,
  type RemoteTerminalFrame,
  type RemoteTerminalSnapshot,
  type ServerMessage,
  type WorkbenchSnapshot,
} from '../protocol/index.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { attentionBody, isLedgerNotice, noticeHeadline } from '../workbench/notices.ts'
import { routeAttention, type ClientPresence } from '../workbench/presence.ts'
import { advertiseCandidates, type AdvertiseCandidate } from './advertise.ts'
import { executeSocketCommand, HostCommandSignal, socketAttachment, withPreviewTranscript, type PendingNavigation, type PreviewTranscript, type RuntimeCommandHostOptions } from './server-runtime.ts'
import { SessionAdmissionError, type SessionRuntime } from './session-runtime.ts'
import { timingSafeEqualToken } from './token.ts'
import type { HostIdentity } from '../protocol/host-identity.ts'

export interface WorkspaceHostOptions {
  browserIntegrations?: BrowserIntegrationService | undefined
  sleepPrevention?: SleepPreventionService | undefined
  terminals?: TerminalSessionService | undefined
  controller: WorkbenchController
  flows: FlowRuntime
  workspacePath: string
  port: number
  hostname?: string | undefined
  token: string
  staticRoot?: string | undefined
  extraHostUrls?: (() => readonly string[]) | undefined
  runtime?: SessionRuntime | undefined
  loadSessionHistory?: RuntimeCommandHostOptions['loadSessionHistory']
  // Who this machine is, sent in every welcome and on /health so clients can label and distinguish hosts.
  identity?: HostIdentity | undefined
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
  presence?: ClientPresence
  clientId: string
  sessionKey: string
  navigationGeneration?: number
  pendingNavigation?: PendingNavigation
  previewTranscript?: PreviewTranscript
}

export const DEFAULT_HOST_PORT = 4817
export const DEFAULT_HOST_BIND = '127.0.0.1'
const TERMINAL_FRAME_MS = 33

export function createWorkspaceHost(options: WorkspaceHostOptions): WorkspaceHost {
  const hostname = options.hostname ?? DEFAULT_HOST_BIND
  const staticRoot = options.staticRoot && existsSync(options.staticRoot) ? resolve(options.staticRoot) : undefined
  const sockets = new Set<Bun.ServerWebSocket<SocketData>>()
  const dirtyTerminalIds = new Set<string>()
  let terminalFrameTimer: ReturnType<typeof setTimeout> | undefined

  const broadcastTerminal = (): void => {
    if (!options.terminals) return
    const snapshot = serializeRemoteTerminal(options.terminals)
    for (const socket of sockets) send(socket, { kind: 'terminal', snapshot })
  }

  const flushTerminalFrames = (): void => {
    terminalFrameTimer = undefined
    if (!options.terminals || dirtyTerminalIds.size === 0) return
    const ids = [...dirtyTerminalIds]
    dirtyTerminalIds.clear()
    for (const id of ids) {
      const frame = serializeRemoteTerminalFrame(options.terminals, id)
      if (!frame) continue
      for (const socket of sockets) send(socket, { kind: 'terminalFrame', frame })
    }
  }

  const scheduleTerminalFrame = (id: string): void => {
    dirtyTerminalIds.add(id)
    if (terminalFrameTimer) return
    terminalFrameTimer = setTimeout(flushTerminalFrames, TERMINAL_FRAME_MS)
  }

  const sendCurrentTerminal = (socket: Bun.ServerWebSocket<SocketData>): void => {
    if (!options.terminals) return
    const snapshot = serializeRemoteTerminal(options.terminals)
    send(socket, { kind: 'terminal', snapshot })
    for (const session of snapshot.sessions) {
      const frame = serializeRemoteTerminalFrame(options.terminals, session.id)
      if (frame) send(socket, { kind: 'terminalFrame', frame })
    }
  }

  const server = Bun.serve<SocketData>({
    hostname,
    port: options.port,
    fetch(request, bunServer) {
      const url = new URL(request.url)
      if (url.pathname === '/ws') {
        if (!authorized(request, url, options.token)) return new Response('Unauthorized', { status: 401 })
        const upgraded = bunServer.upgrade(request, { data: { lastSnapshot: undefined, scheduled: false, clientId: crypto.randomUUID(), sessionKey: options.runtime?.defaultSessionKey ?? 'default' } })
        return upgraded ? undefined : new Response('WebSocket upgrade failed', { status: 426 })
      }
      if (url.pathname === '/health') {
        return Response.json({ ok: true, protocol: PROTOCOL_VERSION, workspacePath: options.workspacePath, ...(options.identity ? { host: options.identity } : {}) })
      }
      if (staticRoot && request.method === 'GET') return serveStatic(staticRoot, url.pathname)
      return new Response('Heddlework workspace host', { status: 404 })
    },
    websocket: {
      open(socket) {
        sockets.add(socket)
        const attachment = socketAttachment({
          runtime: options.runtime,
          controller: options.controller,
          flows: options.flows,
          browserIntegrations: options.browserIntegrations,
          sleepPrevention: options.sleepPrevention,
          terminals: options.terminals,
        }, socket)
        const snapshot = serializeSnapshot(attachment.controller.getSnapshot())
        socket.data.lastSnapshot = snapshot
        send(socket, {
          kind: 'welcome',
          protocol: PROTOCOL_VERSION,
          workspacePath: options.workspacePath,
          snapshot,
          flows: attachment.flows.getSnapshot(),
          ...(options.browserIntegrations ? { browserIntegrations: options.browserIntegrations.getSnapshot() } : {}),
          ...(options.sleepPrevention ? { sleepPrevention: options.sleepPrevention.getSnapshot() } : {}),
          ...(options.terminals ? { terminal: serializeRemoteTerminal(options.terminals) } : {}),
          hostUrls: [...(options.extraHostUrls?.() ?? []), ...remoteHostUrls(hostname, server.port ?? options.port)],
          ...(options.identity ? { host: options.identity } : {}),
        })
        sendCurrentTerminal(socket)
      },
      close(socket) {
        const attachment = socketAttachment({
          runtime: options.runtime,
          controller: options.controller,
          flows: options.flows,
          browserIntegrations: options.browserIntegrations,
          sleepPrevention: options.sleepPrevention,
          terminals: options.terminals,
        }, socket)
        if (socket.data.presence?.clientId) attachment.controller.presence.remove(socket.data.presence.clientId)
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
        const hostCommand = {
          runtime: options.runtime,
          controller: options.controller,
          flows: options.flows,
          browserIntegrations: options.browserIntegrations,
          sleepPrevention: options.sleepPrevention,
          terminals: options.terminals,
          loadSessionHistory: options.loadSessionHistory,
        }
        try {
          const commandValue = await executeSocketCommand(hostCommand, socket, message, (target, payload) => send(target as Bun.ServerWebSocket<SocketData>, payload))
          if (message.command.type === 'reportPresence') {
            const attachment = socketAttachment(hostCommand, socket)
            const presence = attachment.controller.presence.get(message.command.clientId)
            if (presence) socket.data.presence = presence
          }
          send(socket, { kind: 'result', id: message.id, ok: true, ...(commandValue !== undefined ? { value: commandValue } : {}) })
        } catch (error) {
          if (error instanceof HostCommandSignal && error.message === 'in-flight') return
          if (error instanceof SessionAdmissionError) {
            send(socket, { kind: 'result', id: message.id, ok: false, error: error.message })
            return
          }
          send(socket, { kind: 'result', id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
      },
    },
  })

  const publishSession = (sessionKey: string): void => {
    const bundle = options.runtime?.bundleForKey(sessionKey)
    const controller = bundle?.controller ?? options.controller
    for (const socket of sockets) {
      if (socket.data.sessionKey !== sessionKey) continue
      // A bundle that is still booting for this socket publishes an empty Ready snapshot before its
      // transcript loads. The switch preview already owns the socket; resyncSocket lands the real bundle.
      if (socket.data.pendingNavigation && socket.data.pendingNavigation.error === undefined) continue
      if (socket.data.scheduled) continue
      socket.data.scheduled = true
      queueMicrotask(() => {
        socket.data.scheduled = false
        if (!sockets.has(socket)) return
        if (socket.data.sessionKey !== sessionKey) return
        const next = withPreviewTranscript(socket, serializeSnapshot(controller.getSnapshot()))
        const patch = diffSnapshots(socket.data.lastSnapshot, next)
        socket.data.lastSnapshot = next
        if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
      })
    }
  }

  const unsubscribeBrowser = options.browserIntegrations?.subscribe(() => {
    const browserIntegrations = options.browserIntegrations!.getSnapshot()
    for (const socket of sockets) send(socket, { kind: 'browserIntegrations', browserIntegrations })
  })
  const unsubscribeSleep = options.sleepPrevention?.subscribe(() => {
    const sleepPrevention = options.sleepPrevention!.getSnapshot()
    for (const socket of sockets) send(socket, { kind: 'sleepPrevention', sleepPrevention })
  })
  const unsubscribeTerminalState = options.terminals?.subscribeState(broadcastTerminal)
  const unsubscribeTerminalFrames = options.terminals?.subscribeFrames(scheduleTerminalFrame)
  const seenAttention = new Set<string>()
  const flushAttention = (): void => {
    const controllers: WorkbenchController[] = []
    if (options.runtime) options.runtime.forEachSession((_sessionKey, bundle) => controllers.push(bundle.controller))
    else controllers.push(options.controller)
    for (const controller of controllers) {
      const notices = controller.getSnapshot().notices.filter(isLedgerNotice)
      for (const notice of notices) {
        const eventId = notice.eventId ?? (`id:${notice.id}`)
        if (seenAttention.has(eventId)) continue
        seenAttention.add(eventId)
        if (seenAttention.size > 200) {
          const oldest = seenAttention.values().next().value
          if (oldest !== undefined) seenAttention.delete(oldest)
        }
        const targets = new Set(routeAttention({
          createdAt: notice.createdAt,
          ...(notice.sessionPath ? { sessionPath: notice.sessionPath } : {}),
        }, controller.presence.list()))
        if (targets.size === 0) continue
        const event = {
          eventId,
          noticeId: notice.id,
          title: noticeHeadline(notice),
          body: attentionBody(notice),
          ...(notice.sessionPath ? { sessionPath: notice.sessionPath } : {}),
        }
        for (const socket of sockets) {
          const clientId = socket.data.presence?.clientId
          if (clientId && targets.has(clientId)) send(socket, { kind: 'attention', event })
        }
      }
    }
  }

  const unsubscribeController = options.runtime
    ? options.runtime.subscribeSnapshots((sessionKey) => {
      publishSession(sessionKey)
      flushAttention()
    })
    : options.controller.subscribe(() => {
      publishSession('default')
      flushAttention()
    })

  const unsubscribeSessionKeys = options.runtime?.subscribeSessionKeys((fromKey, toKey) => {
    for (const socket of sockets) {
      if (socket.data.sessionKey === fromKey) socket.data.sessionKey = toKey
    }
  })

  const unsubscribeFlows = options.runtime
    ? options.runtime.subscribeFlowSnapshots((sessionKey) => {
      const bundle = options.runtime!.bundleForKey(sessionKey)
      if (!bundle) return
      const snapshot = bundle.flows.getSnapshot()
      for (const socket of sockets) {
        if (socket.data.sessionKey !== sessionKey) continue
        send(socket, { kind: 'flows', snapshot })
      }
    })
    : options.flows.subscribe(() => {
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
      if (terminalFrameTimer) clearTimeout(terminalFrameTimer)
      unsubscribeBrowser?.()
      unsubscribeSleep?.()
      unsubscribeTerminalState?.()
      unsubscribeTerminalFrames?.()
      unsubscribeController()
      unsubscribeSessionKeys?.()
      unsubscribeFlows()
      for (const socket of sockets) socket.close(1001, 'Host shutting down')
      sockets.clear()
      await server.stop(true)
    },
  }
}

export function hostConnectUrl(host: Pick<WorkspaceHost, 'url' | 'token'>): string {
  return withConnectToken(host.url, host.token)
}

export function withConnectToken(url: string, token: string): string {
  return `${url.replace(/\/+$/, '')}/?token=${encodeURIComponent(token)}`
}

export function lanIPv4(): string | undefined {
  return advertiseCandidates().find((candidate) => candidate.kind === 'lan')?.address
}

// The link a phone should use: an explicit HEDDLEWORK_HOST_ADVERTISE, else Tailscale, else LAN, else the bound address.
export function lanConnectUrl(host: Pick<WorkspaceHost, 'port' | 'hostname' | 'token' | 'url'>): string {
  return remoteConnectUrls(host)[0]?.url ?? hostConnectUrl(host)
}

export function preferredPairingLink(host: Pick<WorkspaceHost, 'port' | 'hostname' | 'token' | 'url'>, serveUrl?: string): string | undefined {
  if (serveUrl) return withConnectToken(serveUrl, host.token)
  return phonePairingLink(host)
}

export function bestConnectUrl(host: Pick<WorkspaceHost, 'port' | 'hostname' | 'token' | 'url'>, serveUrl?: string): string {
  return preferredPairingLink(host, serveUrl) ?? hostConnectUrl(host)
}

// Base URLs (no token) a remote client can try if its current address stops working.
export function remoteHostUrls(hostname: string, port: number): string[] {
  if (hostname !== '0.0.0.0' && hostname !== '::') return []
  return advertiseCandidates().map((candidate) => `http://${formatHost(candidate.address)}:${port}`)
}

export interface RemoteConnectUrl {
  kind: AdvertiseCandidate['kind']
  url: string
}

// Every address a device off this machine could reach, best first. Empty when the host is loopback-only.
export function remoteConnectUrls(host: Pick<WorkspaceHost, 'port' | 'hostname' | 'token' | 'url'>): RemoteConnectUrl[] {
  if (host.hostname !== '0.0.0.0' && host.hostname !== '::') return []
  const token = encodeURIComponent(host.token)
  return advertiseCandidates().map((candidate) => ({ kind: candidate.kind, url: `http://${formatHost(candidate.address)}:${host.port}/?token=${token}` }))
}

// Network-reachable connect URL a phone can scan. Never a loopback address.
export function phonePairingLink(host: Pick<WorkspaceHost, 'port' | 'hostname' | 'token' | 'url'>): string | undefined {
  return remoteConnectUrls(host).find((remote) => remote.kind !== 'loopback')?.url
}

export function serializeRemoteTerminal(service: TerminalSessionService): RemoteTerminalSnapshot {
  const snapshot = service.getStateSnapshot()
  return {
    sessions: snapshot.sessions.map((session) => ({
      id: session.id,
      name: session.name,
      title: session.title,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      status: session.status.kind,
      ...(session.status.kind === 'exited' ? { exitCode: session.status.exitCode } : {}),
    })),
    ...(snapshot.activeBottomId ? { activeId: snapshot.activeBottomId } : snapshot.activeRightId ? { activeId: snapshot.activeRightId } : {}),
  }
}

export function serializeRemoteTerminalFrame(service: TerminalSessionService, id: string): RemoteTerminalFrame | undefined {
  const grid = service.grid(id)
  if (!grid) return undefined
  return {
    id,
    cols: grid.cols,
    rows: grid.rows,
    cursorX: grid.cursorX,
    cursorY: grid.cursorY,
    cursorVisible: grid.cursorVisible,
    title: grid.title,
    lines: grid.viewport.map((row) => row.text.replace(/[ \t]+$/u, '')),
  }
}

function formatHost(address: string): string {
  return address.includes(':') && !address.startsWith('[') ? `[${address}]` : address
}

function authorized(request: Request, url: URL, token: string): boolean {
  const header = request.headers.get('authorization')
  const bearer = header?.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : undefined
  return timingSafeEqualToken(token, url.searchParams.get('token')) || timingSafeEqualToken(token, bearer)
}

function send(socket: Bun.ServerWebSocket<SocketData>, message: ServerMessage): void {
  try {
    const json = JSON.stringify(message)
    const bytes = utf8ByteLength(json)
    if (bytes > MAX_ASSEMBLED_BYTES) {
      if (message.kind === 'error') return
      socket.send(JSON.stringify({
        kind: 'error',
        message: `Workspace snapshot is too large to send (${bytes} bytes). Open a smaller session.`,
      } satisfies ServerMessage))
      return
    }
    for (const frame of encodeFrames(json)) socket.send(frame)
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
