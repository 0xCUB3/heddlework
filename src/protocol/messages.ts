import type { BrowserIntegrationSnapshot } from '../browser/integration-types.ts'
import type { FlowRuntimeSnapshot } from '../flows/types.ts'
import type { WorkbenchCommand } from './commands.ts'
import type { SnapshotPatch, WorkbenchSnapshot } from './snapshot.ts'

export type ClientMessage =
  | { kind: 'hello'; protocol: number }
  | { kind: 'command'; id: number; command: WorkbenchCommand }
  | { kind: 'ping' }

export type ServerMessage =
  | { kind: 'welcome'; protocol: number; workspacePath: string; snapshot: WorkbenchSnapshot; flows: FlowRuntimeSnapshot; hostUrls?: string[]; browserIntegrations?: BrowserIntegrationSnapshot }
  | { kind: 'browserIntegrations'; browserIntegrations: BrowserIntegrationSnapshot }
  | { kind: 'patch'; patch: SnapshotPatch }
  | { kind: 'flows'; snapshot: FlowRuntimeSnapshot }
  | { kind: 'result'; id: number; ok: true }
  | { kind: 'result'; id: number; ok: false; error: string }
  | { kind: 'error'; message: string }
  | { kind: 'pong' }

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
  return kind === 'welcome' || kind === 'patch' || kind === 'flows' || kind === 'browserIntegrations' || kind === 'result' || kind === 'error' || kind === 'pong'
    ? value as ServerMessage
    : undefined
}
