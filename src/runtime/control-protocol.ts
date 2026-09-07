import type { RemoteAccessMode } from '../host/remote-access.ts'
import type { RemoteConnectUrl } from '../host/server.ts'
import type { TailnetServeSnapshot } from '../host/tailscale-serve.ts'
import type { TailscaleHttpsPort } from '../host/tailscale-cli.ts'

/** Serializable host view for Settings and pairing UI (no live WorkspaceHost instance). */
export interface RuntimeHostSnapshot {
  url: string
  port: number
  hostname: string
  token: string
  workspacePath: string
}

export interface RuntimeRemoteAccessSnapshot {
  mode: RemoteAccessMode
  busy: boolean
  lockedBy?: string | undefined
  error?: string | undefined
  host?: RuntimeHostSnapshot | undefined
}

/** GET /settings/status — authoritative remote-access + tailnet snapshot from the supervised runtime. */
export interface RuntimeSettingsStatus {
  workspacePath: string
  remote: RuntimeRemoteAccessSnapshot
  tailnet: TailnetServeSnapshot
  /** Connect URLs a phone or browser can try (best first). Empty when remote access is off. */
  remotes: RemoteConnectUrl[]
}

/** POST /settings/remote body. Runtime agent correlates responses by requestId. */
export type RuntimeSettingsRequest =
  | { requestId: string; op: 'setRemoteAccessMode'; mode: RemoteAccessMode }
  | { requestId: string; op: 'setTailnetEnabled'; enabled: boolean }
  | { requestId: string; op: 'setTailnetHttpsPort'; port: TailscaleHttpsPort }
  | { requestId: string; op: 'refreshTailnet' }

export type RuntimeSettingsResponse =
  | { requestId: string; ok: true; status: RuntimeSettingsStatus }
  | { requestId: string; ok: false; error: string }

export function isRuntimeSettingsResponse(value: unknown): value is RuntimeSettingsResponse {
  if (!value || typeof value !== 'object') return false
  const record = value as { requestId?: unknown; ok?: unknown }
  return typeof record.requestId === 'string' && (record.ok === true || record.ok === false)
}

export function nextRuntimeControlRequestId(): string {
  return `ctrl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

