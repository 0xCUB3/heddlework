import type { RemoteAccessMode, RemoteAccessState, RemoteAccessSurface } from '../host/remote-access.ts'
import type { TailnetServeSurface } from '../host/tailnet-serve.ts'
import type { WorkspaceHost } from '../host/server.ts'
import { inspectTailnetServe, type TailnetServeSnapshot } from '../host/tailscale-serve.ts'
import {
  isRuntimeSettingsResponse,
  nextRuntimeControlRequestId,
  type RuntimeHostSnapshot,
  type RuntimeRemoteAccessSnapshot,
  type RuntimeSettingsRequest,
  type RuntimeSettingsStatus,
} from '../runtime/control-protocol.ts'

export interface RuntimeSettingsControlOptions {
  /** Base URL of the supervised runtime HTTP server (same host as workspaceUrl, no /ws). */
  baseUrl: string
  token: string
  fetch?: typeof fetch | undefined
}

export class RuntimeSettingsControl {
  readonly #baseUrl: string
  readonly #token: string
  readonly #fetch: typeof fetch

  constructor(options: RuntimeSettingsControlOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.#token = options.token
    this.#fetch = options.fetch ?? fetch
  }

  async status(): Promise<RuntimeSettingsStatus> {
    const response = await this.#fetch(`${this.#baseUrl}/settings/status`, {
      headers: { Authorization: `Bearer ${this.#token}` },
    })
    if (!response.ok) throw new Error(`Settings status failed (${response.status})`)
    return await response.json() as RuntimeSettingsStatus
  }

  async apply(request: RuntimeSettingsRequest): Promise<RuntimeSettingsStatus> {
    const response = await this.#fetch(`${this.#baseUrl}/settings/remote`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.#token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
    })
    if (!response.ok) throw new Error(`Settings update failed (${response.status})`)
    const payload: unknown = await response.json()
    if (!isRuntimeSettingsResponse(payload)) throw new Error('Invalid settings response')
    if (payload.requestId !== request.requestId) throw new Error('Settings response requestId mismatch')
    if (!payload.ok) throw new Error(payload.error)
    return payload.status
  }
}

class SnapshotWorkspaceHost implements WorkspaceHost {
  readonly url: string
  readonly port: number
  readonly hostname: string
  readonly token: string
  readonly workspacePath: string

  constructor(snapshot: RuntimeHostSnapshot) {
    this.url = snapshot.url
    this.port = snapshot.port
    this.hostname = snapshot.hostname
    this.token = snapshot.token
    this.workspacePath = snapshot.workspacePath
  }

  connectionCount(): number { return 0 }

  close(): Promise<void> {
    return Promise.reject(new Error('The workspace host is owned by the supervised runtime'))
  }
}

function remoteAccessStateFromStatus(status: RuntimeSettingsStatus): RemoteAccessState {
  const host = status.remote.host ? new SnapshotWorkspaceHost(status.remote.host) : undefined
  return {
    mode: status.remote.mode,
    host,
    busy: status.remote.busy,
    lockedBy: status.remote.lockedBy,
    error: status.remote.error,
  }
}

export type RuntimeRemoteAccessFacade = RemoteAccessSurface
export type RuntimeTailnetServeFacade = TailnetServeSurface

export interface RuntimeRemoteSettingsFacades {
  remoteAccess: RuntimeRemoteAccessFacade
  tailnetServe: RuntimeTailnetServeFacade
  dispose(): void
}

/** HTTP-backed RemoteAccessService + TailnetServeService for native attach (Settings UI parity). */
export function createRuntimeRemoteSettingsFacades(control: RuntimeSettingsControl): RuntimeRemoteSettingsFacades {
  let remoteState: RemoteAccessState = { mode: 'off', host: undefined, busy: true, lockedBy: undefined, error: undefined }
  let tailnetSnapshot: TailnetServeSnapshot = inspectTailnetServe({ preference: { enabled: false }, hostPort: undefined })
  const listeners = new Set<() => void>()
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let disposed = false

  const emit = (): void => { for (const listener of listeners) listener() }

  const refresh = async (): Promise<void> => {
    const status = await control.status()
    remoteState = remoteAccessStateFromStatus(status)
    tailnetSnapshot = status.tailnet
    emit()
  }

  const post = async (request: RuntimeSettingsRequest): Promise<void> => {
    remoteState = { ...remoteState, busy: true, error: undefined }
    emit()
    try {
      const status = await control.apply(request)
      remoteState = remoteAccessStateFromStatus(status)
      tailnetSnapshot = status.tailnet
    } catch (cause) {
      remoteState = { ...remoteState, busy: false, error: cause instanceof Error ? cause.message : String(cause) }
      emit()
      throw cause
    }
    remoteState = { ...remoteState, busy: false }
    emit()
  }

  void refresh().catch(() => undefined)
  pollTimer = setInterval(() => { void refresh().catch(() => undefined) }, 5_000)
  pollTimer.unref?.()

  const remoteAccess: RuntimeRemoteAccessFacade = {
    get host() { return remoteState.host },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => remoteState,
    setMode: (mode: RemoteAccessMode) => post({ requestId: nextRuntimeControlRequestId(), op: 'setRemoteAccessMode', mode }),
    close: async () => { disposed = true; if (pollTimer) clearInterval(pollTimer); listeners.clear() },
  }

  const tailnetServe: RuntimeTailnetServeFacade = {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => tailnetSnapshot,
    advertisedHostUrls: () => tailnetSnapshot.status === 'ready' && tailnetSnapshot.url ? [tailnetSnapshot.url] : [],
    refresh: () => post({ requestId: nextRuntimeControlRequestId(), op: 'refreshTailnet' }).then(() => undefined),
    reconcile: () => refresh().then(() => undefined),
    idle: () => Promise.resolve(),
    setEnabled: (enabled: boolean) => post({ requestId: nextRuntimeControlRequestId(), op: 'setTailnetEnabled', enabled }),
    setHttpsPort: (port) => post({ requestId: nextRuntimeControlRequestId(), op: 'setTailnetHttpsPort', port }),
    dispose: async () => { disposed = true; if (pollTimer) clearInterval(pollTimer); listeners.clear() },
  }

  return {
    remoteAccess,
    tailnetServe,
    dispose: () => { void remoteAccess.close() },
  }
}



