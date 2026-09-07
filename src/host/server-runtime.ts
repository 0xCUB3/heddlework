import { resolve } from 'node:path'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import { PiSessionHistoryPager, SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES, SESSION_HISTORY_PAGE_MAX_MESSAGES, SESSION_HISTORY_PAGE_MESSAGES } from '../pi/session-history.ts'
import { createQueueState } from '../workbench/queue.ts'
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
import type { WorkbenchState } from '../workbench/state.ts'
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

function sendSwitchPreview(
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
  socket: Bun.ServerWebSocket<{ lastSnapshot: WorkbenchSnapshot | undefined }>,
  current: WorkbenchState,
  sessionPath: string,
): void {
  const summary = current.sessions.find((session) => session.path === sessionPath)
  const preview: WorkbenchState = {
    ...current,
    ...(summary?.cwd ? { workspacePath: resolve(summary.cwd) } : {}),
    session: { ...current.session, sessionId: summary?.id ?? sessionPath, sessionFile: sessionPath, ...(summary?.title ? { sessionName: summary.title } : {}), isStreaming: false },
    connection: 'connecting', connectionMessage: 'Opening thread', activity: 'Opening thread',
    messages: [], messagesHasOlder: false, messagesLoadingEarlier: false,
    liveAssistant: undefined, liveTools: [], forkMessages: [], stats: undefined,
    dialog: undefined, dialogQueue: [], statusItems: {}, widgets: {},
    questionnaireSubmitting: undefined, questionnaireCollapsed: undefined,
    editorText: '', editorImages: [], queue: createQueueState(),
    workspaceDiff: { status: 'idle', branch: '', files: [], additions: 0, deletions: 0 },
  }
  const pushPreview = (state: WorkbenchState): void => {
    const next = serializeSnapshot(state)
    const patch = diffSnapshots(socket.data.lastSnapshot, next)
    socket.data.lastSnapshot = next
    if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
  }
  pushPreview(preview)
  let lastPreview = socket.data.lastSnapshot
  void new PiSessionHistoryPager(sessionPath).loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, {
    minimumConversationMessages: SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES,
    maximumMessages: SESSION_HISTORY_PAGE_MAX_MESSAGES,
  }).then((page) => {
    // Only fill in the transcript while this preview is still what the socket shows. If another click
    // or the real bundle already replaced it, that state wins.
    if (socket.data.lastSnapshot !== lastPreview) return
    pushPreview({ ...preview, messages: page.messages, messagesHasOlder: page.hasOlder })
    lastPreview = socket.data.lastSnapshot
  }).catch(() => { /* No transcript yet; the bundle's bootstrap fills it in. */ })
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
      const path = message.command.path
      const target = options.runtime.bundleForKey(resolve(path))
      // A thread with no live bundle needs a Pi process, which takes seconds. Show the thread now from
      // the current snapshot plus its transcript on disk; the real bundle replaces it when it lands.
      if (!target) sendSwitchPreview(send, socket, controller.getSnapshot(), path)
      const bundle = await options.runtime.ensureSession(path)
      socket.data.sessionKey = resolve(path)
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
