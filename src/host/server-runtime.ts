import { resolve } from 'node:path'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import { PiSessionHistoryPager, SESSION_HISTORY_PAGE_MESSAGES } from '../pi/session-history.ts'
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
  loadSessionHistory?: ((sessionPath: string) => Promise<{ messages: WorkbenchState['messages']; hasOlder: boolean }>) | undefined
}

export interface PendingNavigation {
  generation: number
  promise: Promise<void>
  error?: unknown
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
  socket: Bun.ServerWebSocket<PreviewSocketData>,
  current: WorkbenchState,
  sessionPath: string,
  isCurrent: () => boolean,
  loadHistory: (sessionPath: string) => Promise<{ messages: WorkbenchState['messages']; hasOlder: boolean }>,
): void {
  const targetPath = resolve(sessionPath)
  const summary = current.sessions.find((session) => resolve(session.path) === targetPath)
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
    if (!isCurrent()) return
    const next = serializeSnapshot(state)
    const patch = diffSnapshots(socket.data.lastSnapshot, next)
    socket.data.lastSnapshot = next
    if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
  }
  socket.data.previewTranscript = undefined
  pushPreview(preview)
  void loadHistory(sessionPath).then((page) => {
    // Navigation identity, not snapshot object identity, decides whether this async preview is stale.
    if (!isCurrent()) return
    if (page.messages.length > 0) socket.data.previewTranscript = { sessionFile: targetPath, messages: page.messages, hasOlder: page.hasOlder }
    pushPreview({ ...preview, messages: page.messages, messagesHasOlder: page.hasOlder })
  }).catch(() => { /* No transcript yet; the bundle's bootstrap fills it in. */ })
}

export interface PreviewTranscript {
  sessionFile: string
  messages: WorkbenchState['messages']
  hasOlder: boolean
}

export interface PreviewSocketData {
  lastSnapshot: WorkbenchSnapshot | undefined
  previewTranscript?: PreviewTranscript | undefined
}

// A bundle that just booted reports connected before its transcript loads. Sending its empty message
// list would paint a blank draft over a thread the client is already reading from the disk preview, so
// the preview transcript stays on the socket until the bundle produces messages of its own.
export function withPreviewTranscript(socket: Bun.ServerWebSocket<PreviewSocketData>, next: WorkbenchSnapshot): WorkbenchSnapshot {
  const preview = socket.data.previewTranscript
  if (!preview) return next
  const nextFile = next.session.sessionFile ? resolve(next.session.sessionFile) : undefined
  if ((nextFile !== undefined && nextFile !== preview.sessionFile) || next.messages.length > 0 || next.liveAssistant) {
    socket.data.previewTranscript = undefined
    return next
  }
  return { ...next, messages: preview.messages, messagesHasOlder: preview.hasOlder }
}

export function resyncSocket(
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
  socket: Bun.ServerWebSocket<PreviewSocketData>,
  controller: WorkbenchController,
  flows: FlowRuntime,
): void {
  const next = withPreviewTranscript(socket, serializeSnapshot(controller.getSnapshot()))
  const patch = diffSnapshots(socket.data.lastSnapshot, next)
  socket.data.lastSnapshot = next
  send(socket, { kind: 'flows', snapshot: flows.getSnapshot() })
  if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
}

export async function executeSocketCommand(
  options: RuntimeCommandHostOptions,
  socket: Bun.ServerWebSocket<{
    clientId: string
    sessionKey: string
    lastSnapshot: WorkbenchSnapshot | undefined
    previewTranscript?: PreviewTranscript | undefined
    navigationGeneration?: number | undefined
    pendingNavigation?: PendingNavigation | undefined
  }>,
  message: { id: number; requestId?: string | undefined; command: WorkbenchCommand },
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
): Promise<unknown> {
  const requestId = message.requestId ?? String(message.id)
  const clientId = socket.data.clientId
  if (options.runtime && !['switchSession', 'newSession', 'switchWorkspace'].includes(message.command.type)) {
    const intendedGeneration = socket.data.navigationGeneration ?? 0
    const intendedKey = socket.data.sessionKey
    while (socket.data.pendingNavigation) {
      const pending = socket.data.pendingNavigation
      await pending.promise
      if (pending.error !== undefined) {
        if (socket.data.pendingNavigation === pending) socket.data.pendingNavigation = undefined
        throw new HostCommandSignal('Navigation failed; command was not sent')
      }
      if ((socket.data.navigationGeneration ?? 0) !== intendedGeneration || socket.data.sessionKey !== intendedKey) {
        throw new HostCommandSignal('Navigation changed; command was not sent')
      }
      if (socket.data.pendingNavigation === pending) break
    }
  }
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
      const generation = (socket.data.navigationGeneration ?? 0) + 1
      socket.data.navigationGeneration = generation
      const workspacePath = controller.getSnapshot().workspacePath
      const opening = options.runtime.createNewSession(workspacePath)
      const pending: PendingNavigation = { generation, promise: opening.then(() => undefined, (error) => { pending.error = error }) }
      socket.data.pendingNavigation = pending
      const created = await opening
      if (socket.data.navigationGeneration !== generation) {
        options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
        return undefined
      }
      if (socket.data.pendingNavigation === pending) socket.data.pendingNavigation = undefined
      socket.data.sessionKey = created.sessionKey
      resyncSocket(send, socket, created.bundle.controller, created.bundle.flows)
      options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
      return undefined
    }
    if (options.runtime && message.command.type === 'switchWorkspace') {
      const generation = (socket.data.navigationGeneration ?? 0) + 1
      socket.data.navigationGeneration = generation
      const opening = options.runtime.openWorkspace(message.command.path)
      const pending: PendingNavigation = { generation, promise: opening.then(() => undefined, (error) => { pending.error = error }) }
      socket.data.pendingNavigation = pending
      const opened = await opening
      if (socket.data.navigationGeneration !== generation) {
        options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
        return undefined
      }
      if (socket.data.pendingNavigation === pending) socket.data.pendingNavigation = undefined
      socket.data.sessionKey = opened.sessionKey
      resyncSocket(send, socket, opened.bundle.controller, opened.bundle.flows)
      options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
      return undefined
    }
    if (options.runtime && message.command.type === 'switchSession') {
      const path = message.command.path
      const targetPath = resolve(path)
      const current = controller.getSnapshot()
      const summary = current.sessions.find((candidate) => resolve(candidate.path) === targetPath)
      const generation = (socket.data.navigationGeneration ?? 0) + 1
      socket.data.navigationGeneration = generation
      let previewActive = true
      // Stop old-session broadcasts immediately; commands arriving during startup wait below instead of
      // accidentally attaching to the previous live bundle.
      socket.data.sessionKey = targetPath
      const target = options.runtime.bundleForKey(targetPath)
      // A thread with no live bundle needs a Pi process, which takes seconds. Show the thread now from
      // the current snapshot plus its transcript on disk; the real bundle replaces it when it lands.
      const isCurrent = () => previewActive && socket.data.navigationGeneration === generation && socket.data.sessionKey === targetPath
      const loadHistory = options.loadSessionHistory ?? ((sessionPath: string) => new PiSessionHistoryPager(sessionPath).loadEarlier(SESSION_HISTORY_PAGE_MESSAGES))
      if (!target) sendSwitchPreview(send, socket, current, path, isCurrent, loadHistory)
      const opening = options.runtime.ensureSession(path, summary)
      const pending: PendingNavigation = { generation, promise: opening.then(() => undefined, (error) => { pending.error = error }) }
      socket.data.pendingNavigation = pending
      const bundle = await opening.catch((error) => {
        previewActive = false
        if (socket.data.navigationGeneration === generation && socket.data.sessionKey === targetPath) {
          socket.data.sessionKey = sessionKey
          resyncSocket(send, socket, controller, flows)
        }
        throw error
      })
      if (!isCurrent()) {
        options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
        return undefined
      }
      previewActive = false
      if (socket.data.pendingNavigation === pending) socket.data.pendingNavigation = undefined
      resyncSocket(send, socket, bundle.controller, bundle.flows)
      options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
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
