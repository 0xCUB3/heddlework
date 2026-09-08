import { resolve } from 'node:path'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import { PiSessionHistoryPager, SESSION_HISTORY_PAGE_MAX_MESSAGES, SESSION_HISTORY_PAGE_MESSAGES } from '../pi/session-history.ts'
import { createQueueState } from '../workbench/queue.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import type { SleepPreventionService } from '../power/service.ts'
import {
  applyWorkbenchCommand,
  clampTranscriptDetailLimit,
  diffSnapshots,
  findOmittedTranscriptEntry,
  findTranscriptDetail,
  isPatchEmpty,
  pageTranscriptDetail,
  projectWorkbenchSnapshot,
  sameSessionFile,
  serializeSnapshot,
  type ServerMessage,
  type TranscriptDetail,
  type TranscriptDetailSource,
  type WorkbenchCommand,
} from '../protocol/index.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import type { PiMessage } from '../pi/types.ts'
import { type SessionRuntime } from './session-runtime.ts'
import type { WorkbenchSnapshot } from '../protocol/snapshot.ts'

// A long-lived bundle accumulates far more transcript than one socket should receive at once; the wBlock
// session reached 64MB in memory and tripped the wire cap on every open. Each socket sees a tail window
// anchored at a message it already holds, and scroll-up reveals in-memory rows before touching the pager.
export const SOCKET_TRANSCRIPT_WINDOW_MESSAGES = 240

export interface TranscriptWindow {
  sessionFile: string | undefined
  anchorId: string | undefined
  anchor: PiMessage
  sliced?: { source: readonly PiMessage[]; start: number; messages: PiMessage[] }
}

export interface WindowSocketData {
  transcriptWindow?: TranscriptWindow | undefined
}

function windowAnchorIndex(messages: readonly PiMessage[], window: TranscriptWindow): number {
  if (window.anchorId !== undefined) {
    const byId = messages.findIndex((message) => message.workbenchEntryId === window.anchorId)
    if (byId >= 0) return byId
  }
  return messages.indexOf(window.anchor)
}

function anchorAt(messages: readonly PiMessage[], index: number, sessionFile: string | undefined): TranscriptWindow {
  const anchor = messages[index]!
  return { sessionFile, anchorId: typeof anchor.workbenchEntryId === 'string' ? anchor.workbenchEntryId : undefined, anchor }
}

export function withTranscriptWindow(socket: Bun.ServerWebSocket<WindowSocketData>, next: WorkbenchSnapshot): WorkbenchSnapshot {
  const messages = next.messages
  const sessionFile = next.session.sessionFile ? resolve(next.session.sessionFile) : undefined
  const current = socket.data.transcriptWindow
  if (current && sessionFile && current.sessionFile !== sessionFile) socket.data.transcriptWindow = undefined
  if (messages.length === 0) return next
  let start = current && current.sessionFile === sessionFile ? windowAnchorIndex(messages, current) : -1
  if (start < 0) {
    start = Math.max(0, messages.length - SOCKET_TRANSCRIPT_WINDOW_MESSAGES)
    socket.data.transcriptWindow = anchorAt(messages, start, sessionFile)
  }
  if (start === 0) return next
  const window = socket.data.transcriptWindow!
  const sliced = window.sliced && window.sliced.source === messages && window.sliced.start === start
    ? window.sliced.messages
    : messages.slice(start)
  window.sliced = { source: messages, start, messages: sliced }
  return { ...next, messages: sliced, messagesHasOlder: true }
}

export function socketSnapshot(socket: Bun.ServerWebSocket<PreviewSocketData & WindowSocketData>, state: WorkbenchState): WorkbenchSnapshot {
  return projectWorkbenchSnapshot(withTranscriptWindow(socket, withPreviewTranscript(socket, serializeSnapshot(state))))
}

export function pushSocketSnapshot(
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
  socket: Bun.ServerWebSocket<PreviewSocketData & WindowSocketData>,
  controller: WorkbenchController,
): void {
  const next = socketSnapshot(socket, controller.getSnapshot())
  const patch = diffSnapshots(socket.data.lastSnapshot, next)
  socket.data.lastSnapshot = next
  if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
}

// Reveal one more page of the bundle's own transcript, or ask the controller for a disk page once the
// socket already sees everything in memory. Returns true when the socket's window moved.
export async function revealEarlierMessages(
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
  socket: Bun.ServerWebSocket<PreviewSocketData & WindowSocketData>,
  controller: WorkbenchController,
): Promise<void> {
  const state = controller.getSnapshot()
  const window = socket.data.transcriptWindow
  const sessionFile = state.session.sessionFile ? resolve(state.session.sessionFile) : undefined
  const index = window && window.sessionFile === sessionFile ? windowAnchorIndex(state.messages, window) : -1
  if (index > 0) {
    socket.data.transcriptWindow = anchorAt(state.messages, Math.max(0, index - SESSION_HISTORY_PAGE_MESSAGES), sessionFile)
    pushSocketSnapshot(send, socket, controller)
    return
  }
  await controller.loadEarlierMessages()
  const after = controller.getSnapshot()
  const afterFile = after.session.sessionFile ? resolve(after.session.sessionFile) : undefined
  if (after.messages.length > 0 && afterFile === sessionFile) socket.data.transcriptWindow = anchorAt(after.messages, 0, sessionFile)
  pushSocketSnapshot(send, socket, controller)
}

export interface RuntimeCommandHostOptions {
  runtime?: SessionRuntime | undefined
  controller: WorkbenchController
  flows: FlowRuntime
  browserIntegrations?: BrowserIntegrationService | undefined
  sleepPrevention?: SleepPreventionService | undefined
  terminals?: TerminalSessionService | undefined
  loadSessionHistory?: ((sessionPath: string) => Promise<{ messages: WorkbenchState['messages']; hasOlder: boolean }>) | undefined
  loadSessionEntry?: ((sessionPath: string, entryId: string) => Promise<PiMessage | undefined>) | undefined
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

function commandNeedsExecutionLease(type: WorkbenchCommand['type']): boolean {
  return type === 'submit'
    || type === 'queueInput'
    || type === 'updateQueuedInput'
    || type === 'removeQueuedInput'
    || type === 'moveQueuedInput'
    || type === 'moveQueuedInputToLane'
    || type === 'toggleQueuedInputPause'
    || type === 'steerQueuedInput'
    || type === 'resumeQueue'
    || type === 'pause'
    || type === 'abort'
    || type === 'compact'
    || type === 'setModel'
    || type === 'setThinkingLevel'
    || type === 'navigateTree'
    || type === 'cloneSession'
    || type === 'exportSession'
    || type === 'drainQueueMessages'
    || type === 'cancelBlockingQueueActivity'
    || type === 'queueFabricPeerGate'
    || type === 'removeQueuedFlow'
    || type === 'respondToDialog'
    || type === 'submitAskUserQuestionnaire'
    || type === 'cancelAskUserQuestionnaire'
    || type === 'renameThread'
}

export function commandAllowedWithoutLease(type: WorkbenchCommand['type']): boolean {
  return type === 'reportPresence'
    || type === 'refreshSessions'
    || type === 'loadMoreSessions'
    || type === 'pinThread'
    || type === 'unpinThread'
    || type === 'settleThread'
    || type === 'snoozeThread'
    || type === 'wakeThread'
    || type === 'setThreadPriority'
    || type === 'setThreadLabels'
    || type === 'markThreadRead'
    || type === 'markThreadsRead'
    || type === 'setThreadTitleSettings'
    || type === 'dismissNotice'
    || type === 'markNoticeRead'
    || type === 'markNoticesRead'
    || type === 'clearNotices'
    || type === 'getTranscriptDetail'
    || type === 'loadEarlierMessages'
    || type === 'setEditorText'
    || type === 'addEditorImage'
    || type === 'removeEditorImage'
    || type === 'refreshWorkspaceDiff'
    || type === 'clearReceipts'
}

export function socketAttachment(
  options: RuntimeCommandHostOptions,
  socket: Bun.ServerWebSocket<{ sessionKey: string }>,
): { controller: WorkbenchController; flows: FlowRuntime; sessionKey: string; leased: boolean } {
  if (options.runtime) {
    const requested = socket.data.sessionKey
    const bundle = options.runtime.bundleForKey(requested)
    if (bundle) return { controller: bundle.controller, flows: bundle.flows, sessionKey: requested, leased: true }
    return { controller: options.controller, flows: options.flows, sessionKey: requested, leased: false }
  }
  return { controller: options.controller, flows: options.flows, sessionKey: socket.data.sessionKey, leased: true }
}

function sendNewSessionPreview(
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
  socket: Bun.ServerWebSocket<PreviewSocketData & WindowSocketData>,
  current: WorkbenchState,
): void {
  const preview: WorkbenchState = {
    ...current,
    session: { model: current.session.model, thinkingLevel: current.session.thinkingLevel, sessionId: '', isStreaming: false },
    connection: 'connecting', connectionMessage: 'Starting thread', activity: 'Starting thread',
    messages: [], messagesHasOlder: false, messagesLoadingEarlier: false,
    liveAssistant: undefined, liveTools: [], forkMessages: [], stats: undefined,
    dialog: undefined, dialogQueue: [], statusItems: {}, widgets: {},
    questionnaireSubmitting: undefined, questionnaireCollapsed: undefined,
    editorText: '', editorImages: [], queue: createQueueState(),
    workspaceDiff: { status: 'idle', branch: '', files: [], additions: 0, deletions: 0 },
  }
  socket.data.previewTranscript = undefined
  const next = projectWorkbenchSnapshot(withTranscriptWindow(socket, serializeSnapshot(preview)))
  const patch = diffSnapshots(socket.data.lastSnapshot, next)
  socket.data.lastSnapshot = next
  if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
}

function sendSwitchPreview(
  send: (socket: Bun.ServerWebSocket<unknown>, message: ServerMessage) => void,
  socket: Bun.ServerWebSocket<PreviewSocketData & WindowSocketData>,
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
    const next = projectWorkbenchSnapshot(withTranscriptWindow(socket, serializeSnapshot(state)))
    const patch = diffSnapshots(socket.data.lastSnapshot, next)
    socket.data.lastSnapshot = next
    if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
  }
  socket.data.previewTranscript = undefined
  socket.data.transcriptWindow = undefined
  pushPreview(preview)
  const settle = (messages: WorkbenchState['messages'], hasOlder: boolean) => {
    if (!isCurrent()) return
    if (messages.length > 0) socket.data.previewTranscript = { sessionFile: targetPath, messages, hasOlder }
    pushPreview({
      ...preview,
      connection: 'connected',
      connectionMessage: 'Connected',
      activity: 'Ready',
      messages,
      messagesHasOlder: hasOlder,
    })
  }
  void loadHistory(sessionPath).then((page) => {
    // Navigation identity, not snapshot object identity, decides whether this async preview is stale.
    settle(page.messages, page.hasOlder)
  }).catch(() => {
    settle([], false)
  })
}

export interface PreviewTranscript {
  sessionFile: string
  messages: WorkbenchState['messages']
  hasOlder: boolean
}

export interface PreviewSocketData {
  lastSnapshot: WorkbenchSnapshot | undefined
  previewTranscript?: PreviewTranscript | undefined
  loadEarlierTask?: Promise<void> | undefined
}

// A bundle that just booted reports connected before its transcript loads. Sending its empty message
// list would paint a blank draft over a thread the client is already reading from the disk preview, so
// the preview transcript stays on the socket until the bundle produces messages of its own.
export function lookupSocketTranscriptDetail(
  state: WorkbenchState,
  preview: PreviewTranscript | undefined,
  entryId: string,
): TranscriptDetailSource | undefined {
  return findTranscriptDetail({ messages: state.messages, liveTools: state.liveTools, liveAssistant: state.liveAssistant }, entryId)
    ?? findTranscriptDetail({ messages: preview?.messages }, entryId)
}

async function resolveSocketTranscriptDetail(
  options: RuntimeCommandHostOptions,
  socket: Bun.ServerWebSocket<{ sessionKey: string; previewTranscript?: PreviewTranscript | undefined }>,
  controller: WorkbenchController,
  command: { entryId: string; offset?: number; limit?: number; sessionFile?: string; requestId?: string },
): Promise<TranscriptDetail> {
  if (!command.entryId) throw new Error('Transcript entry id is required')
  const selected = resolve(socket.data.sessionKey)
  const controllerState = controller.getSnapshot()
  const pagingSession = controllerState.session.sessionFile
    ?? socket.data.previewTranscript?.sessionFile
    ?? (socket.data.sessionKey.endsWith('.jsonl') ? socket.data.sessionKey : undefined)
  const paging = {
    offset: command.offset ?? 0,
    limit: clampTranscriptDetailLimit(command.limit),
    ...(pagingSession ? { sessionFile: pagingSession } : {}),
    ...(command.requestId ? { requestId: command.requestId } : {}),
  }
  const activeFile = controllerState.session.sessionFile ?? socket.data.previewTranscript?.sessionFile
  if (command.sessionFile && activeFile && !sameSessionFile(command.sessionFile, activeFile) && resolve(command.sessionFile) !== resolve(activeFile)) {
    throw new Error('Session changed')
  }
  const controllerFile = controllerState.session.sessionFile
  const controllerMatches = !options.runtime || (controllerFile !== undefined && resolve(controllerFile) === selected)
  const controllerSources = {
    messages: controllerState.messages,
    liveTools: controllerState.liveTools,
    liveAssistant: controllerState.liveAssistant,
  }
  if (controllerMatches) {
    const fromController = findTranscriptDetail(controllerSources, command.entryId)
    if (fromController) return pageTranscriptDetail(fromController, paging)
  }
  const preview = socket.data.previewTranscript
  const previewMatches = preview !== undefined && resolve(preview.sessionFile) === selected
  if (previewMatches) {
    const fromPreview = findTranscriptDetail({ messages: preview.messages }, command.entryId)
    if (fromPreview) return pageTranscriptDetail(fromPreview, paging)
  }
  const omitted = (controllerMatches ? findOmittedTranscriptEntry(controllerSources, command.entryId) : undefined)
    ?? (previewMatches ? findOmittedTranscriptEntry({ messages: preview!.messages }, command.entryId) : undefined)
  const loadId = omitted?.entryId ?? command.entryId
  const load = options.loadSessionEntry
    ?? (options.runtime
      ? (sessionPath: string, entryId: string) => options.runtime!.loadHistoryEntry(sessionPath, entryId)
      : undefined)
  const loaded = load ? await load(socket.data.sessionKey, loadId) : await new PiSessionHistoryPager(socket.data.sessionKey).loadEntry(loadId)
  if (!loaded) throw new Error('Unknown transcript entry: ' + command.entryId)
  return pageTranscriptDetail({ kind: 'message', entryId: loadId, message: loaded }, paging)
}

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
  socket: Bun.ServerWebSocket<PreviewSocketData & WindowSocketData>,
  controller: WorkbenchController,
  flows: FlowRuntime,
): void {
  send(socket, { kind: 'flows', snapshot: flows.getSnapshot() })
  pushSocketSnapshot(send, socket, controller)
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
    transcriptWindow?: TranscriptWindow | undefined
    loadEarlierTask?: Promise<void> | undefined
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
  try {
    if (options.runtime && message.command.type === 'switchSession') {
      const path = message.command.path
      const targetPath = resolve(path)
      const previous = options.runtime.bundleForKey(socket.data.sessionKey)?.controller.getSnapshot() ?? options.controller.getSnapshot()
      const generation = (socket.data.navigationGeneration ?? 0) + 1
      socket.data.navigationGeneration = generation
      const previousKey = socket.data.sessionKey
      socket.data.sessionKey = targetPath
      if (previousKey !== targetPath) {
        options.runtime.releaseSocket(previousKey)
        options.runtime.retainSocket(targetPath)
      }
      const target = options.runtime.bundleForKey(targetPath)
      const isCurrent = () => socket.data.navigationGeneration === generation && socket.data.sessionKey === targetPath && !options.runtime!.hasExecutionLease(targetPath)
      const loadHistory = options.loadSessionHistory ?? ((sessionPath: string) => options.runtime!.browseHistory(sessionPath))
      if (target) {
        resyncSocket(send, socket, target.controller, target.flows)
      } else {
        sendSwitchPreview(send, socket, previous, path, isCurrent, loadHistory)
      }
      options.runtime.recordCommandResult(clientId, requestId, message.command, targetPath, true)
      void options.runtime.releaseIdleExecutionLeases()
      return undefined
    }

    if (options.runtime && commandNeedsExecutionLease(message.command.type) && !options.runtime.hasExecutionLease(socket.data.sessionKey)) {
      const intendedGeneration = socket.data.navigationGeneration ?? 0
      const intendedKey = socket.data.sessionKey
      const summary = (socket.data.lastSnapshot?.sessions ?? options.controller.getSnapshot().sessions)
        .find((candidate) => resolve(candidate.path) === resolve(intendedKey))
      const opening = options.runtime.ensureSession(intendedKey, summary)
      const pending: PendingNavigation = { generation: intendedGeneration, promise: opening.then(() => undefined, (error) => { pending.error = error }) }
      socket.data.pendingNavigation = pending
      const bundle = await opening.catch((error) => {
        if (socket.data.pendingNavigation === pending) socket.data.pendingNavigation = undefined
        throw error
      })
      if ((socket.data.navigationGeneration ?? 0) !== intendedGeneration || socket.data.sessionKey !== intendedKey) {
        options.runtime.recordCommandResult(clientId, requestId, message.command, intendedKey, true)
        throw new HostCommandSignal('Navigation changed; command was not sent')
      }
      if (socket.data.pendingNavigation === pending) socket.data.pendingNavigation = undefined
      const preview = socket.data.lastSnapshot
      if (preview) {
        bundle.controller.setEditorText(preview.editorText)
        for (const image of preview.editorImages) {
          if (typeof image.data === 'string') bundle.controller.addEditorImage(image as import('../pi/types.ts').ComposerImage)
        }
      }
      resyncSocket(send, socket, bundle.controller, bundle.flows)
    }

    if (options.runtime && !options.runtime.hasExecutionLease(socket.data.sessionKey)) {
      if (message.command.type === 'loadEarlierMessages') {
        const intendedGeneration = socket.data.navigationGeneration ?? 0
        const intendedKey = socket.data.sessionKey
        const pending = socket.data.loadEarlierTask
        if (pending) await pending
        if ((socket.data.navigationGeneration ?? 0) !== intendedGeneration || socket.data.sessionKey !== intendedKey) {
          options.runtime.recordCommandResult(clientId, requestId, message.command, intendedKey, true)
          return undefined
        }
        let finish!: () => void
        const task = new Promise<void>((resolve) => { finish = resolve })
        socket.data.loadEarlierTask = task
        try {
          const loadHistory = options.loadSessionHistory ?? ((sessionPath: string) => options.runtime!.browseHistory(sessionPath))
          const page = await loadHistory(intendedKey)
          if ((socket.data.navigationGeneration ?? 0) !== intendedGeneration || socket.data.sessionKey !== intendedKey) {
            options.runtime.recordCommandResult(clientId, requestId, message.command, intendedKey, true)
            return undefined
          }
          const current = socket.data.lastSnapshot
          if (current && page.messages.length > 0) {
            const known = new Set(current.messages.flatMap((message) => message.workbenchEntryId ? [message.workbenchEntryId] : []))
            const older = page.messages.filter((message) => !known.has(message.workbenchEntryId ?? ''))
            const combined = [...older, ...current.messages]
            const messages = combined.length <= SESSION_HISTORY_PAGE_MAX_MESSAGES
              ? combined
              : combined.slice(0, SESSION_HISTORY_PAGE_MAX_MESSAGES)
            const hasOlder = page.hasOlder || combined.length > messages.length
            socket.data.previewTranscript = { sessionFile: resolve(socket.data.sessionKey), messages, hasOlder }
            const next = { ...current, messages, messagesHasOlder: hasOlder }
            const patch = diffSnapshots(current, next)
            socket.data.lastSnapshot = next
            if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
          }
          options.runtime.recordCommandResult(clientId, requestId, message.command, socket.data.sessionKey, true)
          return undefined
        } finally {
          finish()
          if (socket.data.loadEarlierTask === task) socket.data.loadEarlierTask = undefined
        }
      }
      if (message.command.type === 'setEditorText') {
        const current = socket.data.lastSnapshot
        if (current) {
          const next = { ...current, editorText: message.command.text }
          const patch = diffSnapshots(current, next)
          socket.data.lastSnapshot = next
          if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
        }
        options.runtime.recordCommandResult(clientId, requestId, message.command, socket.data.sessionKey, true)
        return undefined
      }
      if (message.command.type === 'addEditorImage' || message.command.type === 'removeEditorImage') {
        const current = socket.data.lastSnapshot
        if (current) {
          const editorImages = message.command.type === 'addEditorImage'
            ? [...current.editorImages, message.command.image]
            : current.editorImages.filter((image) => image.id !== (message.command as { id: string }).id)
          const next = { ...current, editorImages }
          const patch = diffSnapshots(current, next)
          socket.data.lastSnapshot = next
          if (!isPatchEmpty(patch)) send(socket, { kind: 'patch', patch })
        }
        options.runtime.recordCommandResult(clientId, requestId, message.command, socket.data.sessionKey, true)
        return undefined
      }
    }

    const { controller, flows, sessionKey, leased } = socketAttachment(options, socket)
    if (options.runtime && !leased && !commandNeedsExecutionLease(message.command.type) && !commandAllowedWithoutLease(message.command.type)) {
      throw new HostCommandSignal(message.command.type + ' is not available without an execution lease')
    }

    if (options.runtime) {
      const decision = options.runtime.admission(clientId, requestId, message.command, sessionKey)
      if (decision.action === 'respond') {
        const record = decision.record
        if (record.error === 'in-flight') throw new HostCommandSignal('in-flight')
        if (record.ok) return record.value
        throw new HostCommandSignal(record.error ?? 'failed')
      }
    }

    if (options.runtime && message.command.type === 'newSession') {
      const generation = (socket.data.navigationGeneration ?? 0) + 1
      socket.data.navigationGeneration = generation
      const current = controller.getSnapshot()
      const workspacePath = current.workspacePath
      // Booting a Pi process takes seconds. Paint an empty draft for this workspace now so the click lands
      // immediately; the real bundle replaces it through resyncSocket when it is ready.
      sendNewSessionPreview(send, socket, current)
      const opening = options.runtime.createNewSession(workspacePath)
      const pending: PendingNavigation = { generation, promise: opening.then(() => undefined, (error) => { pending.error = error }) }
      socket.data.pendingNavigation = pending
      const created = await opening.catch((error) => {
        if (socket.data.navigationGeneration === generation) resyncSocket(send, socket, controller, flows)
        throw error
      })
      if (socket.data.navigationGeneration !== generation) {
        options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
        return undefined
      }
      if (socket.data.pendingNavigation === pending) socket.data.pendingNavigation = undefined
      const previousKey = socket.data.sessionKey
      socket.data.sessionKey = created.sessionKey
      if (previousKey !== created.sessionKey) {
        options.runtime.releaseSocket(previousKey)
        options.runtime.retainSocket(created.sessionKey)
      }
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
      const previousKey = socket.data.sessionKey
      socket.data.sessionKey = opened.sessionKey
      if (previousKey !== opened.sessionKey) {
        options.runtime.releaseSocket(previousKey)
        options.runtime.retainSocket(opened.sessionKey)
      }
      resyncSocket(send, socket, opened.bundle.controller, opened.bundle.flows)
      options.runtime.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
      return undefined
    }

    if (message.command.type === 'getTranscriptDetail') {
      const detail = await resolveSocketTranscriptDetail(options, socket, controller, message.command)
      options.runtime?.recordCommandResult(clientId, requestId, message.command, sessionKey, true, detail)
      return detail
    }
    if (message.command.type === 'loadEarlierMessages') {
      await revealEarlierMessages(send, socket, controller)
      options.runtime?.recordCommandResult(clientId, requestId, message.command, sessionKey, true)
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
    options.runtime?.recordCommandResult(clientId, requestId, message.command, socket.data.sessionKey, false, undefined, error instanceof Error ? error.message : String(error))
    throw error
  }
}
