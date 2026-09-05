import { parseServerMessage, type WorkbenchCommand, type WorkbenchSnapshot } from '../protocol/index.ts'
import type { FlowRuntimeSnapshot } from '../flows/types.ts'

export type WorkspaceClientStatus = 'connecting' | 'open' | 'closed'

export interface WorkspaceClientView {
  status: WorkspaceClientStatus
  workspacePath: string
  state: WorkbenchSnapshot | undefined
  flows: FlowRuntimeSnapshot | undefined
  lastError?: string | undefined
}

const MIN_BACKOFF_MS = 500
const MAX_BACKOFF_MS = 10_000
// After this many failed attempts on one address the client tries the next one the host advertised.
const FAILURES_BEFORE_ROTATE = 2

export class WorkspaceClient {
  #socket: WebSocket | undefined
  #url = ''
  #token = ''
  #candidates: string[] = []
  #failures = 0
  #wantOpen = false
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined
  #backoff = MIN_BACKOFF_MS
  #commandId = 0
  #pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
  #listeners = new Set<() => void>()
  #view: WorkspaceClientView = { status: 'closed', workspacePath: '', state: undefined, flows: undefined }

  connect(url: string, token: string, alternates: readonly string[] = []): void {
    this.disconnect()
    this.#url = url
    this.#token = token
    this.#candidates = mergeCandidates(url, alternates)
    this.#failures = 0
    this.#wantOpen = true
    this.#backoff = MIN_BACKOFF_MS
    this.#open()
  }

  disconnect(): void {
    this.#wantOpen = false
    if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
    this.#reconnectTimer = undefined
    this.#socket?.close()
    this.#socket = undefined
    this.#failPending(new Error('Disconnected'))
    this.#set({ status: 'closed' })
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  getSnapshot(): WorkspaceClientView {
    return this.#view
  }

  // The address currently in use; changes when the client rotates to a host-advertised fallback.
  get url(): string {
    return this.#url
  }

  get candidates(): readonly string[] {
    return this.#candidates
  }

  send(command: WorkbenchCommand): Promise<void> {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected'))
    const id = ++this.#commandId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ kind: 'command', id, command }))
    })
  }

  #open(): void {
    this.#set({ status: 'connecting' })
    const socket = new WebSocket(workspaceSocketUrl(this.#url, this.#token))
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.#backoff = MIN_BACKOFF_MS
      this.#failures = 0
      socket.send(JSON.stringify({ kind: 'hello', protocol: 1 }))
    })
    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return
      const message = parseServerMessage(typeof event.data === 'string' ? event.data : undefined)
      if (!message) return
      if (message.kind === 'welcome') {
        this.#candidates = mergeCandidates(this.#url, message.hostUrls)
        this.#set({ status: 'open', workspacePath: message.workspacePath, state: message.snapshot, flows: message.flows })
        return
      }
      if (message.kind === 'patch' && this.#view.state) {
        this.#set({ state: { ...this.#view.state, ...message.patch.changed } })
        return
      }
      if (message.kind === 'flows') {
        this.#set({ flows: message.snapshot })
        return
      }
      if (message.kind === 'result') {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        if (message.ok) pending.resolve()
        else pending.reject(new Error(message.error))
        return
      }
      if (message.kind === 'error') this.#set({ lastError: message.message })
    })
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#failPending(new Error('Socket closed'))
      this.#set({ status: 'closed' })
      this.#failures += 1
      this.#rotateIfStuck()
      this.#scheduleReconnect()
    })
    socket.addEventListener('error', () => {
      if (this.#socket !== socket) return
      this.#set({ lastError: 'Socket error' })
    })
  }

  #rotateIfStuck(): void {
    if (this.#failures < FAILURES_BEFORE_ROTATE || this.#candidates.length < 2) return
    const index = this.#candidates.indexOf(this.#url)
    this.#url = this.#candidates[(index + 1) % this.#candidates.length] ?? this.#url
    this.#failures = 0
    this.#backoff = MIN_BACKOFF_MS
  }

  #scheduleReconnect(): void {
    if (!this.#wantOpen) return
    const delay = this.#backoff
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS)
    this.#set({ status: 'connecting' })
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined
      if (this.#wantOpen) this.#open()
    }, delay)
  }

  #failPending(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error)
    this.#pending.clear()
  }

  #set(patch: Partial<WorkspaceClientView>): void {
    this.#view = { ...this.#view, ...patch }
    for (const listener of this.#listeners) listener()
  }
}

// The address that worked stays first; host-advertised alternates follow in the host's preference order.
export function mergeCandidates(current: string, advertised: readonly string[] | undefined): string[] {
  const normalize = (value: string) => value.replace(/\/+$/, '')
  const seen = new Set<string>([normalize(current)])
  const merged = [normalize(current)]
  for (const url of advertised ?? []) {
    const clean = normalize(url)
    if (!seen.has(clean)) { seen.add(clean); merged.push(clean) }
  }
  return merged
}

export function workspaceSocketUrl(hostUrl: string, token: string): string {
  const base = hostUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
  const url = new URL(base.includes('://') ? base : `ws://${base}`)
  if (!url.pathname.endsWith('/ws')) url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
  if (token) url.searchParams.set('token', token)
  return url.toString()
}

export function readConnectionSettings(search = '', storage: Pick<Storage, 'getItem'> | undefined = undefined, origin = ''): { host: string; token: string } {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  return {
    host: params.get('host') ?? storage?.getItem('heddlework.host') ?? origin,
    token: params.get('token') ?? storage?.getItem('heddlework.token') ?? '',
  }
}
