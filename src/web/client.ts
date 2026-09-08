import type { BrowserIntegrationSnapshot } from '../browser/integration-types.ts'
import { applySnapshotPatch, FrameAssembler, mergeTranscriptDetail, normalizeHostIdentity, parseServerMessage, PROTOCOL_VERSION, sameSessionFile, snapshotNeedsLiveResync, TranscriptExpansionCache, type AttentionEvent, type HostIdentity, type TranscriptDetail, type WorkbenchCommand, type WorkbenchSnapshot } from '../protocol/index.ts'
import type { FlowRuntimeSnapshot } from '../flows/types.ts'
import type { SleepPreventionSnapshot } from '../power/types.ts'

export type WorkspaceClientStatus = 'connecting' | 'open' | 'closed'

export interface WorkspaceClientView {
  browserIntegrations?: BrowserIntegrationSnapshot | undefined
  sleepPrevention?: SleepPreventionSnapshot | undefined
  status: WorkspaceClientStatus
  workspacePath: string
  // Identity of the host that sent the last welcome; undefined for hosts that predate it.
  host?: HostIdentity | undefined
  // The URL this client is currently connected through (may rotate among advertised candidates).
  url?: string | undefined
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
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  #listeners = new Set<() => void>()
  #attentionListeners = new Set<(event: AttentionEvent) => void>()
  #frames = new FrameAssembler()
  #liveSeq = 0
  #expansion = new TranscriptExpansionCache()
  #detailInflight = new Map<string, Promise<TranscriptDetail>>()
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
    this.#set({ status: 'closed', browserIntegrations: undefined, sleepPrevention: undefined })
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  onAttention(listener: (event: AttentionEvent) => void): () => void {
    this.#attentionListeners.add(listener)
    return () => { this.#attentionListeners.delete(listener) }
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

  send(command: WorkbenchCommand): Promise<unknown> {
    const socket = this.#socket
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Not connected'))
    const id = ++this.#commandId
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ kind: 'command', id, command }))
    })
  }

  sendAndReport(command: WorkbenchCommand): Promise<void> {
    return this.send(command).then(
      () => undefined,
      (error: unknown) => {
        this.reportError(error)
      },
    )
  }

  async getTranscriptDetail(entryId: string, options: { offset?: number; limit?: number } = {}): Promise<TranscriptDetail> {
    const sessionFile = this.#view.state?.session?.sessionFile
    const offset = options.offset ?? 0
    const inflightKey = `${sessionFile ?? ''}\0${entryId}\0${offset}\0${options.limit ?? ''}`
    const pending = this.#detailInflight.get(inflightKey)
    if (pending) return pending
    const request = this.#fetchTranscriptDetail(entryId, options, sessionFile)
    this.#detailInflight.set(inflightKey, request)
    try {
      return await request
    } finally {
      if (this.#detailInflight.get(inflightKey) === request) this.#detailInflight.delete(inflightKey)
    }
  }

  async #fetchTranscriptDetail(
    entryId: string,
    options: { offset?: number; limit?: number },
    sessionFile: string | undefined,
  ): Promise<TranscriptDetail> {
    const value = await this.send({
      type: 'getTranscriptDetail',
      entryId,
      ...(sessionFile ? { sessionFile } : {}),
      ...(options.offset !== undefined ? { offset: options.offset } : {}),
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    }) as TranscriptDetail
    const state = this.#view.state
    if (!state || !value || (value.kind !== 'message' && value.kind !== 'tool' && value.kind !== 'liveAssistant')) return value
    if (sessionFile && state.session?.sessionFile && !sameSessionFile(state.session.sessionFile, sessionFile)) return value
    if (value.sessionFile && state.session?.sessionFile && !sameSessionFile(value.sessionFile, state.session.sessionFile)) return value
    this.#set({ state: mergeTranscriptDetail(state, value, this.#expansion) })
    return value
  }

  reconnect(): void {
    if (!this.#url) return
    this.connect(this.#url, this.#token, this.#candidates)
  }

  reportError(error: unknown): void {
    this.#set({ lastError: error instanceof Error ? error.message : String(error) })
  }

  #open(): void {
    this.#set({ status: 'connecting' })
    this.#frames.reset()
    const socket = new WebSocket(workspaceSocketUrl(this.#url, this.#token))
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      this.#backoff = MIN_BACKOFF_MS
      this.#failures = 0
      socket.send(JSON.stringify({ kind: 'hello', protocol: PROTOCOL_VERSION }))
    })
    socket.addEventListener('message', (event) => {
      if (this.#socket !== socket) return
      if (typeof event.data !== 'string') return
      let assembled: unknown
      try {
        assembled = this.#frames.push(event.data)
      } catch (error) {
        this.#set({ lastError: error instanceof Error ? error.message : String(error) })
        return
      }
      if (assembled === undefined) return
      const message = parseServerMessage(assembled)
      if (!message) return
      if (message.kind === 'welcome') {
        this.#candidates = mergeCandidates(this.#url, message.hostUrls)
        // A fresh welcome supersedes any error from the previous socket (rejected sends, socket errors), otherwise the
        // red status line outlives the outage it described.
        this.#liveSeq = 0
        this.#expansion.switchSession()
        this.#detailInflight.clear()
        this.#set({ status: 'open', lastError: undefined, workspacePath: message.workspacePath, host: normalizeHostIdentity(message.host), url: this.#url, state: this.#expansion.overlay(normalizeSettledSnapshot(message.snapshot)), flows: message.flows, browserIntegrations: message.browserIntegrations, sleepPrevention: message.sleepPrevention })
        return
      }
      if (message.kind === 'patch' && this.#view.state) {
        if (snapshotNeedsLiveResync(this.#liveSeq, message.patch)) {
          this.reconnect()
          return
        }
        if (message.patch.seq != null) this.#liveSeq = message.patch.seq
        if (message.patch.liveOps) this.#expansion.noteLiveOps(this.#view.state, message.patch.liveOps)
        const previousFile = this.#view.state.session?.sessionFile
        const next = normalizeSettledSnapshot(applySnapshotPatch(this.#view.state, message.patch))
        if (previousFile && next.session?.sessionFile && !sameSessionFile(previousFile, next.session.sessionFile)) {
          this.#expansion.switchSession()
          this.#detailInflight.clear()
        }
        this.#set({ state: this.#expansion.overlay(next) })
        return
      }
      if (message.kind === 'browserIntegrations') {
        this.#set({ browserIntegrations: message.browserIntegrations })
        return
      }
      if (message.kind === 'sleepPrevention') {
        this.#set({ sleepPrevention: message.sleepPrevention })
        return
      }
      if (message.kind === 'flows') {
        this.#set({ flows: message.snapshot })
        return
      }
      if (message.kind === 'attention') {
        for (const listener of this.#attentionListeners) listener(message.event)
        return
      }
      if (message.kind === 'result') {
        const pending = this.#pending.get(message.id)
        if (!pending) return
        this.#pending.delete(message.id)
        if (message.ok && this.#view.lastError) this.#set({ lastError: undefined })
        if (message.ok) pending.resolve('value' in message ? message.value : undefined)
        else pending.reject(new Error(message.error))
        return
      }
      if (message.kind === 'error') this.#set({ lastError: message.message })
    })
    socket.addEventListener('close', () => {
      if (this.#socket !== socket) return
      this.#socket = undefined
      this.#failPending(new Error('Socket closed'))
      this.#set({ status: 'closed', browserIntegrations: undefined, sleepPrevention: undefined })
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

function normalizeSettledSnapshot(snapshot: WorkbenchSnapshot): WorkbenchSnapshot {
  if (!snapshot.session || !Array.isArray(snapshot.liveTools)) return snapshot
  if (snapshot.session.isStreaming) return snapshot
  if (!snapshot.liveAssistant && snapshot.liveTools.length === 0) return snapshot
  return { ...snapshot, liveAssistant: undefined, liveTools: [] }
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
