import type { BrowserIntegrationSnapshot } from '../browser/integration-types.ts'
import type { FlowRuntimeSnapshot } from '../flows/types.ts'
import type { SleepPreventionSnapshot } from '../power/types.ts'
import type { WorkbenchCommand } from './commands.ts'
import type { SnapshotPatch, WorkbenchSnapshot } from './snapshot.ts'
import type { RemoteTerminalFrame, RemoteTerminalSnapshot } from './terminal.ts'

export type ClientMessage =
  | { kind: 'hello'; protocol: number }
  | { kind: 'command'; id: number; command: WorkbenchCommand }
  | { kind: 'ping' }

export interface AttentionEvent {
  eventId: string
  noticeId: number
  title: string
  body: string
  sessionPath?: string
}

export type ServerMessage =
  | { kind: 'welcome'; protocol: number; workspacePath: string; snapshot: WorkbenchSnapshot; flows: FlowRuntimeSnapshot; hostUrls?: string[]; browserIntegrations?: BrowserIntegrationSnapshot; sleepPrevention?: SleepPreventionSnapshot; terminal?: RemoteTerminalSnapshot }
  | { kind: 'browserIntegrations'; browserIntegrations: BrowserIntegrationSnapshot }
  | { kind: 'sleepPrevention'; sleepPrevention: SleepPreventionSnapshot }
  | { kind: 'terminal'; snapshot: RemoteTerminalSnapshot }
  | { kind: 'terminalFrame'; frame: RemoteTerminalFrame }
  | { kind: 'patch'; patch: SnapshotPatch }
  | { kind: 'flows'; snapshot: FlowRuntimeSnapshot }
  | { kind: 'attention'; event: AttentionEvent }
  | { kind: 'result'; id: number; ok: true }
  | { kind: 'result'; id: number; ok: false; error: string }
  | { kind: 'error'; message: string }
  | { kind: 'pong' }

const SERVER_KINDS = new Set([
  'welcome', 'patch', 'flows', 'browserIntegrations', 'sleepPrevention', 'terminal', 'terminalFrame', 'attention', 'result', 'error', 'pong',
])

export function parseClientMessage(raw: unknown): ClientMessage | undefined {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const message = value as { kind?: unknown; id?: unknown; protocol?: unknown; command?: unknown }
  switch (message.kind) {
    case 'hello':
      return typeof message.protocol === 'number' ? { kind: 'hello', protocol: message.protocol } : undefined
    case 'command':
      return typeof message.id === 'number' && message.command && typeof message.command === 'object'
        ? { kind: 'command', id: message.id, command: message.command as WorkbenchCommand }
        : undefined
    case 'ping':
      return { kind: 'ping' }
    default:
      return undefined
  }
}

export function parseServerMessage(raw: unknown): ServerMessage | undefined {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object') return undefined
  const kind = (value as { kind?: unknown }).kind
  return typeof kind === 'string' && SERVER_KINDS.has(kind) ? value as ServerMessage : undefined
}
