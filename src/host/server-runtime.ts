import { resolve } from 'node:path'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import type { SleepPreventionService } from '../power/service.ts'
import {
  applyWorkbenchCommand,
  diffSnapshots,
  isPatchEmpty,
  serializeSnapshot,
  type ServerMessage,
  type WorkbenchCommand,
} from '../protocol/index.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { type SessionRuntime } from './session-runtime.ts'
import type { WorkbenchSnapshot } from '../protocol/snapshot.ts'

export interface RuntimeCommandHostOptions {
  runtime?: SessionRuntime | undefined
  controller: WorkbenchController
  flows: FlowRuntime
  browserIntegrations?: BrowserIntegrationService | undefined
  sleepPrevention?: SleepPreventionService | undefined
  terminals?: TerminalSessionService | undefined
}

export class HostCommandSignal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostCommandSignal'
  }
}

export function socketAttachment(
  options: RuntimeCommandHostOptions,
  socket: Bun.ServerWebSocket<{ sessionKey: string }>,
): { controller: WorkbenchController; flows: FlowRuntime; sessionKey: string } {
  if (options.runtime) {
    const attachment = options.runtime.attach(socket.data.sessionKey)
    socket.data.sessionKey = attachment.sessionKey
    return { controller: attachment.controller, flows: attachment.flows, sessionKey: attachment.sessionKey }
  }
  return { controller: options.controller, flows: options.flows, sessionKey: socket.data.sessionKey }
}

export function resyncSocket(
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
  socket: Bun.ServerWebSocket<{ lastSnapshot: WorkbenchSnapshot | undefined }>,
  controller: WorkbenchController,
  flows: FlowRuntime,
): void {
  const next = serializeSnapshot(controller.getSnapshot())
  const patch = diffSnapshots(socket.data.lastSnapshot, next)
  socket.data.lastSnapshot = next
  send(socket, { kind: 'flows', snapshot: flows.getSnapshot() })
  if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
}

export async function executeSocketCommand(
  options: RuntimeCommandHostOptions,
  socket: Bun.ServerWebSocket<{ clientId: string; sessionKey: string; lastSnapshot: WorkbenchSnapshot | undefined }>,
  message: { id: number; requestId?: string | undefined; command: WorkbenchCommand },
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
): Promise<unknown> {
  const requestId = message.requestId ?? String(message.id)
  const clientId = socket.data.clientId
  const { controller, flows, sessionKey } = socketAttachment(options, socket)

  if (options.runtime) {
    const decision = options.runtime.admission(clientId, requestId, message.command, sessionKey)
    if (decision.action === 'respond') {
      const record = decision.record
      if (record.error === 'in-flight') throw new HostCommandSignal('in-flight')
      if (record.ok) return record.value
      throw new HostCommandSignal(record.error ?? 'failed')
    }
  }

  try {
    if (options.runtime && message.command.type === 'newSession') {
      const workspacePath = controller.getSnapshot().workspacePath
      const created = await options.runtime.createNewSession(workspacePath)
      socket.data.sessionKey = created.sessionKey
      resyncSocket(send, socket, created.bundle.controller, created.bundle.flows)
      options.runtime.recordCommandResult(clientId, requestId, message.command, created.sessionKey, true)
      return undefined
    }
    if (options.runtime && message.command.type === 'switchWorkspace') {
      const opened = await options.runtime.openWorkspace(message.command.path)
      socket.data.sessionKey = opened.sessionKey
      resyncSocket(send, socket, opened.bundle.controller, opened.bundle.flows)
      options.runtime.recordCommandResult(clientId, requestId, message.command, opened.sessionKey, true)
      return undefined
    }
    if (options.runtime && message.command.type === 'switchSession') {
      const bundle = await options.runtime.ensureSession(message.command.path)
      socket.data.sessionKey = resolve(message.command.path)
      resyncSocket(send, socket, bundle.controller, bundle.flows)
      options.runtime.recordCommandResult(clientId, requestId, message.command, socket.data.sessionKey, true)
      return undefined
    }

    const commandValue = await applyWorkbenchCommand(controller, message.command, {
      flows,
      browserIntegrations: options.browserIntegrations,
      sleepPrevention: options.sleepPrevention,
      terminals: options.terminals,
    })
    options.runtime?.recordCommandResult(clientId, requestId, message.command, sessionKey, true, commandValue)
    return commandValue
  } catch (error) {
    options.runtime?.recordCommandResult(clientId, requestId, message.command, sessionKey, false, undefined, error instanceof Error ? error.message : String(error))
    throw error
  }
}
