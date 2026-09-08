// Remote WorkbenchControllerSurface for browsers and attach clients. State comes from the host snapshot stream;
// mutations become protocol commands. Method names mirror WorkbenchControllerSurface.

import type { WorkbenchControllerSurface } from '../workbench/controller-surface.ts'
import type { NavigateTreeOptions } from '../workbench/controller.ts'
import type { WorkbenchState, ThreadPriority } from '../workbench/state.ts'
import type { ThreadTitleSettings } from '../workbench/thread-titles.ts'
import { sameSessionFile, TRANSCRIPT_DETAIL_MAX_PAGES, TRANSCRIPT_DETAIL_PAGE_BYTES, type TranscriptDetail, type WorkbenchSnapshot, type WorkbenchCommand } from '../protocol/index.ts'
import type { ComposerImage, PiModel, ThinkingLevel } from '../pi/types.ts'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { MutationReceipt } from '../receipts/types.ts'
import type { NoticeKind } from '../workbench/notices.ts'
import type { QueueInputDraft, QueuedInput, QueueLane } from '../workbench/queue.ts'
import { PresenceRegistry } from '../workbench/presence.ts'
import type { WorkspaceClient } from '../web/client.ts'

const EMPTY_IMAGE_DATA = ''

// Editor text is echoed locally so typing never waits for a host round trip; the host copy is the source of truth only
// when it changes for another reason (submit clears it, another client edits it).
export class RemoteWorkbenchController implements WorkbenchControllerSurface {
  readonly presence = new PresenceRegistry()
  readonly #client: WorkspaceClient
  readonly #listeners = new Set<() => void>()
  #snapshot: WorkbenchState
  #hostSnapshot: WorkbenchSnapshot | undefined
  #localEditorText: string | undefined
  readonly #editorDrafts = new Map<string, string>()
  #editorTimer: ReturnType<typeof setTimeout> | undefined
  #localSelection: string | undefined
  #selectedSession: string | undefined
  #navigationGeneration = 0
  #disposed = false
  #selectionTask: Promise<void> = Promise.resolve()
  readonly #transcriptCache = new Map<string, { messages: WorkbenchState['messages']; hasOlder: boolean }>()
  #unsubscribe: () => void

  constructor(client: WorkspaceClient) {
    this.#client = client
    this.#snapshot = this.#materialize(client.getSnapshot().state)
    this.#selectedSession = this.#snapshot.session?.sessionFile
    if (this.#snapshot.session?.sessionFile && this.#snapshot.messages.length > 0) {
      rememberTranscriptCache(this.#transcriptCache, this.#snapshot.session.sessionFile, this.#snapshot.messages, this.#snapshot.messagesHasOlder)
    }
    this.#unsubscribe = client.subscribe(() => this.#pull())
  }

  get client(): WorkspaceClient { return this.#client }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): WorkbenchState => this.#snapshot

  readonly loadEarlierMessages = async (): Promise<void> => {
    await this.#send({ type: 'loadEarlierMessages' })
  }

  readonly getTranscriptDetail = async (
    entryId: string,
    options: { offset?: number; limit?: number } = {},
  ): Promise<TranscriptDetail> => {
    const generation = this.#navigationGeneration
    const sessionFile = this.#snapshot.session.sessionFile
    const limit = options.limit ?? TRANSCRIPT_DETAIL_PAGE_BYTES
    let offset = options.offset ?? 0
    const singlePage = options.offset !== undefined
    let detail: TranscriptDetail | undefined
    for (let page = 0; page < TRANSCRIPT_DETAIL_MAX_PAGES; page += 1) {
      detail = await this.#client.getTranscriptDetail(entryId, { offset, limit })
      if (generation !== this.#navigationGeneration || !sameSessionFile(this.#snapshot.session.sessionFile, sessionFile)) {
        throw new Error('Session changed')
      }
      if (detail.sessionFile && sessionFile && !sameSessionFile(detail.sessionFile, sessionFile)) throw new Error('Session changed')
      if (singlePage || detail.complete) return detail
      if (detail.bytes <= 0) throw new Error('Transcript detail page made no progress')
      offset = detail.offset + detail.bytes
    }
    if (!detail) throw new Error('Unknown transcript entry: ' + entryId)
    return detail
  }

  #pull(): void {
    const next = this.#client.getSnapshot().state
    if (next === this.#hostSnapshot) return
    const selected = this.#selectedSession ?? this.#localSelection
    const hostFile = next?.session.sessionFile
    if (selected && hostFile && !sameSessionFile(hostFile, selected)) {
      if (!this.#localSelection && this.#client.getSnapshot().status === 'open') {
        this.#localSelection = selected
        void this.#client.send({ type: 'switchSession', path: selected }).catch(() => undefined)
      }
      return
    }
    const openingEmpty = next?.activity === 'Opening thread'
      && next.messages.length === 0
      && this.#snapshot.messages.length > 0
      && sameSessionFile(this.#snapshot.session.sessionFile, hostFile)
    if (openingEmpty) return
    if (this.#localSelection) {
      if (!hostFile || !sameSessionFile(hostFile, this.#localSelection)) return
      this.#localSelection = undefined
    }
    if (hostFile) this.#selectedSession = hostFile
    const previousHost = this.#hostSnapshot
    this.#hostSnapshot = next
    if (next?.session.sessionFile && next.messages.length > 0) {
      rememberTranscriptCache(this.#transcriptCache, next.session.sessionFile, next.messages, next.messagesHasOlder)
    }
    if (previousHost && next && previousHost.editorText !== next.editorText && next.editorText !== this.#localEditorText) this.#localEditorText = undefined
    this.#snapshot = this.#materialize(next)
    this.#emit()
  }

  #materialize(snapshot: WorkbenchSnapshot | undefined): WorkbenchState {
    const base = (snapshot ?? this.#hostSnapshot) as WorkbenchSnapshot | undefined
    if (!base) return this.#snapshot ?? ({} as WorkbenchState)
    const editorImages = base.editorImages.map((image) => ({ ...image, data: typeof image.data === 'string' ? image.data : EMPTY_IMAGE_DATA })) as ComposerImage[]
    // Hosts that predate thread titles omit the key; the UI reads it unconditionally.
    const threadTitles = base.threadTitles ?? { autoTitles: true }
    return { ...base, editorImages, threadTitles, ...(this.#localEditorText !== undefined ? { editorText: this.#localEditorText } : {}) } as WorkbenchState
  }

  #emit(): void { for (const listener of this.#listeners) listener() }

  #send(command: WorkbenchCommand): Promise<void> {
    if (this.#disposed) return Promise.resolve()
    if (command.type !== 'switchSession') {
      return this.#selectionTask.then(() => this.#disposed ? undefined : this.#client.sendAndReport(command))
    }
    return this.#client.sendAndReport(command)
  }

  #cancelEditorTimer(): void {
    if (this.#editorTimer) clearTimeout(this.#editorTimer)
    this.#editorTimer = undefined
  }

  #leaveEditorSession(): void {
    const sessionFile = this.#snapshot.session.sessionFile
    const text = this.#localEditorText
    this.#cancelEditorTimer()
    this.#localEditorText = undefined
    if (text !== undefined) {
      this.#snapshot = { ...this.#snapshot, editorText: '' }
      this.#emit()
    }
    if (text === undefined || !sessionFile || this.#disposed) return
    const hostFile = this.#client.getSnapshot().state?.session.sessionFile
    if (!this.#localSelection && hostFile && sameSessionFile(hostFile, sessionFile)) {
      void this.#client.sendAndReport({ type: 'setEditorText', text })
    }
  }

  async #dispatchEditorText(sessionFile: string, text: string, generation: number): Promise<void> {
    await this.#selectionTask
    if (this.#disposed || generation !== this.#navigationGeneration) return
    const hostFile = this.#client.getSnapshot().state?.session.sessionFile
    if (!hostFile || !sameSessionFile(hostFile, sessionFile)) return
    if (this.#editorDrafts.get(sessionFile) !== text) return
    await this.#client.sendAndReport({ type: 'setEditorText', text })
  }

  acceptAgentEvent(_event: import('../pi/types.ts').RpcRecord): void {
    throw new Error('Agent events are owned by the supervised runtime on attach clients')
  }
  acceptAgentStatus(_status: import('../pi/transport.ts').TransportStatus): void {
    throw new Error('Agent transport status is owned by the supervised runtime on attach clients')
  }
  notify(kind: NoticeKind, message: string, _options?: import('../workbench/state.ts').NoticeOptions): void { void this.#send({ type: 'notify', kind, message }) }
  async start(): Promise<void> {}
  async reconnect(): Promise<void> { this.#client.reconnect() }
  async submit(text: string, options: { queue?: boolean } = {}): Promise<void> {
    const sessionFile = this.#snapshot.session.sessionFile
    this.#cancelEditorTimer()
    if (sessionFile) this.#editorDrafts.delete(sessionFile)
    this.#localEditorText = undefined
    await this.#send({ type: 'submit', text, ...(options.queue ? { queue: true } : {}) })
  }
  queueInput(text: string, _images: readonly ComposerImage[] = [], options: { paused?: boolean; lane?: QueueLane } = {}): undefined {
    void this.#send({ type: 'queueInput', text, ...(options.lane ? { lane: options.lane } : {}), ...(options.paused !== undefined ? { paused: options.paused } : {}) })
    return undefined
  }
  enqueueQueueInputs(_inputs: readonly QueueInputDraft[], _options: { start?: boolean; paused?: boolean } = {}): QueuedInput[] {
    throw new Error('Batch queue enqueue is not available on attach clients; use queueInput')
  }
  hasQueuedFlow(runId: string): boolean { return this.#snapshot.queue.items.some((item) => item.flow?.runId === runId) }
  removeQueuedFlow(runId: string): void { void this.#send({ type: 'removeQueuedFlow', runId }) }
  updateQueuedInput(id: string, text: string): void { void this.#send({ type: 'updateQueuedInput', id, text }) }
  removeQueuedInput(id: string): void { void this.#send({ type: 'removeQueuedInput', id }) }
  moveQueuedInput(id: string, targetIndex: number): void { void this.#send({ type: 'moveQueuedInput', id, targetIndex }) }
  moveQueuedInputToLane(id: string, lane: QueueLane): void { void this.#send({ type: 'moveQueuedInputToLane', id, lane }) }
  toggleQueuedInputPause(id: string): void { void this.#send({ type: 'toggleQueuedInputPause', id }) }
  async queueFabricPeerGate(): Promise<void> { await this.#send({ type: 'queueFabricPeerGate' }) }
  cancelBlockingQueueActivity(): void { void this.#send({ type: 'cancelBlockingQueueActivity' }) }
  async steerQueuedInput(id: string): Promise<void> { await this.#send({ type: 'steerQueuedInput', id }) }
  resumeQueue(): void { void this.#send({ type: 'resumeQueue' }) }
  async drainQueueMessages(): Promise<void> { await this.#send({ type: 'drainQueueMessages' }) }
  async pause(): Promise<void> { await this.#send({ type: 'pause' }) }
  async abort(): Promise<void> { await this.#send({ type: 'abort' }) }
  async newSession(): Promise<void> {
    this.#leaveEditorSession()
    this.#unpinSelectedSession()
    await this.#send({ type: 'newSession' })
  }
  async switchWorkspace(workspacePath: string): Promise<void> {
    this.#leaveEditorSession()
    this.#unpinSelectedSession()
    await this.#send({ type: 'switchWorkspace', path: workspacePath })
  }
  async switchSession(session: PiSessionSummary): Promise<void> {
    this.#leaveEditorSession()
    const generation = ++this.#navigationGeneration
    this.#selectedSession = session.path
    this.#localSelection = session.path
    const draft = this.#editorDrafts.get(session.path)
    this.#localEditorText = draft
    const cached = this.#transcriptCache.get(session.path)
      ?? [...this.#transcriptCache.entries()].find(([path]) => sameSessionFile(path, session.path))?.[1]
      ?? (sameSessionFile(this.#snapshot.session.sessionFile, session.path) && this.#snapshot.messages.length > 0
        ? { messages: this.#snapshot.messages, hasOlder: this.#snapshot.messagesHasOlder }
        : undefined)
    this.#snapshot = {
      ...this.#snapshot,
      ...(session.cwd ? { workspacePath: session.cwd } : {}),
      session: { ...this.#snapshot.session, sessionId: session.id, sessionFile: session.path, sessionName: session.title, isStreaming: false },
      connection: 'connecting',
      connectionMessage: 'Opening thread',
      activity: 'Opening thread',
      messages: cached?.messages ?? [],
      messagesHasOlder: cached?.hasOlder ?? false,
      messagesLoadingEarlier: false,
      liveAssistant: undefined,
      liveTools: [],
      forkMessages: [],
      stats: undefined,
      dialog: undefined,
      dialogQueue: [],
      statusItems: {},
      widgets: {},
      questionnaireSubmitting: undefined,
      questionnaireCollapsed: undefined,
      editorText: draft ?? '',
      editorImages: [],
    }
    this.#emit()
    let release!: () => void
    const previous = this.#selectionTask
    this.#selectionTask = new Promise<void>((resolve) => { release = resolve })
    await previous
    if (generation !== this.#navigationGeneration) {
      release()
      return
    }
    try {
      await this.#client.send({ type: 'switchSession', path: session.path })
    } catch (error) {
      if (generation === this.#navigationGeneration && sameSessionFile(this.#selectedSession, session.path)) {
        this.#localSelection = undefined
        this.#selectedSession = undefined
        this.#snapshot = {
          ...this.#snapshot,
          connection: 'error',
          connectionMessage: error instanceof Error ? error.message : String(error),
          activity: 'Ready',
        }
        this.#emit()
        this.#client.reportError(error)
      }
    } finally {
      release()
    }
  }
  async refreshSessions(): Promise<void> { await this.#send({ type: 'refreshSessions' }) }
  async loadMoreSessions(): Promise<void> { await this.#send({ type: 'loadMoreSessions' }) }
  async openSessionTree(_options: { preserveQueue?: boolean } = {}): Promise<void> {
    throw new Error('Session tree editing is not available on attach clients')
  }
  async navigateTree(entryId: string, _options: NavigateTreeOptions = {}): Promise<void> { await this.#send({ type: 'navigateTree', entryId }) }
  async cloneSession(): Promise<void> {
    this.#leaveEditorSession()
    this.#unpinSelectedSession()
    await this.#send({ type: 'cloneSession' })
  }
  async forkFrom(entryId: string, _options: { preserveQueue?: boolean } = {}): Promise<void> { await this.#send({ type: 'navigateTree', entryId }) }
  async exportSession(): Promise<string | undefined> { await this.#send({ type: 'exportSession' }); return undefined }
  async setModel(model: PiModel): Promise<void> { await this.#send({ type: 'setModel', provider: model.provider, id: model.id }) }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> { await this.#send({ type: 'setThinkingLevel', level }) }
  async compact(): Promise<void> { await this.#send({ type: 'compact' }) }
  completeUiRequest(id: number): void { void this.#send({ type: 'completeUiRequest', id }) }
  setEditorText(text: string): void {
    const sessionFile = this.#snapshot.session.sessionFile
    this.#localEditorText = text
    if (sessionFile) this.#editorDrafts.set(sessionFile, text)
    this.#snapshot = { ...this.#snapshot, editorText: text }
    this.#emit()
    if (this.#editorTimer) clearTimeout(this.#editorTimer)
    const generation = this.#navigationGeneration
    this.#editorTimer = setTimeout(() => {
      this.#editorTimer = undefined
      if (!sessionFile || text !== this.#editorDrafts.get(sessionFile)) return
      void this.#dispatchEditorText(sessionFile, text, generation)
    }, 250)
  }
  addEditorImage(image: ComposerImage): void { void this.#send({ type: 'addEditorImage', image }) }
  removeEditorImage(id: string): void { void this.#send({ type: 'removeEditorImage', id }) }
  dismissNotice(id: number): void { void this.#send({ type: 'dismissNotice', id }) }
  markNoticeRead(id: number): void { void this.#send({ type: 'markNoticeRead', id }) }
  markNoticesRead(): void { void this.#send({ type: 'markNoticesRead' }) }
  async activateNotice(id: number): Promise<void> { await this.#send({ type: 'activateNotice', id }) }
  clearNotices(): void { void this.#send({ type: 'clearNotices' }) }
  #receiptClearListeners = new Set<(sessionPath: string) => void>()
  setReceipts(receipts: MutationReceipt[]): void {
    this.#snapshot = { ...this.#snapshot, receipts }
    this.#emit()
  }
  onClearReceipts(listener: (sessionPath: string) => void): () => void {
    this.#receiptClearListeners.add(listener)
    return () => { this.#receiptClearListeners.delete(listener) }
  }
  clearReceipts(sessionPath: string): void {
    for (const listener of this.#receiptClearListeners) listener(sessionPath)
    void this.#send({ type: 'clearReceipts', sessionPath })
  }
  settleThread(path: string): void { void this.#send({ type: 'settleThread', path }) }
  snoozeThread(path: string, snoozedUntil: number): void { void this.#send({ type: 'snoozeThread', path, snoozedUntil }) }
  wakeThread(path: string): void { void this.#send({ type: 'wakeThread', path }) }
  pinThread(path: string): void { void this.#send({ type: 'pinThread', path }) }
  unpinThread(path: string): void { void this.#send({ type: 'unpinThread', path }) }
  async renameThread(name: string): Promise<void> { await this.#send({ type: 'renameThread', name }) }
  async regenerateThreadTitle(path: string): Promise<void> { await this.#send({ type: 'regenerateThreadTitle', path }) }
  setThreadTitleSettings(settings: Partial<ThreadTitleSettings>): void { void this.#send({ type: 'setThreadTitleSettings', settings }) }
  setThreadPriority(path: string, priority: ThreadPriority | undefined): void { void this.#send({ type: 'setThreadPriority', path, priority }) }
  setThreadLabels(path: string, labels: readonly string[]): void { void this.#send({ type: 'setThreadLabels', path, labels: [...labels] }) }
  markThreadRead(path: string, updatedAt: number): void { void this.#send({ type: 'markThreadRead', path, updatedAt }) }
  markThreadsRead(threads: readonly { path: string; updatedAt: number }[]): void { void this.#send({ type: 'markThreadsRead', threads: [...threads] }) }
  async refreshWorkspaceDiff(): Promise<void> { await this.#send({ type: 'refreshWorkspaceDiff' }) }
  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void { void this.#send({ type: 'respondToDialog', ...response }) }
  submitAskUserQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[], note?: string): void { void this.#send({ type: 'submitAskUserQuestionnaire', toolCallId, answers: [...answers], ...(note === undefined ? {} : { note }) }) }
  cancelAskUserQuestionnaire(toolCallId: string): void { void this.#send({ type: 'cancelAskUserQuestionnaire', toolCallId }) }
  setAskUserQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void { void this.#send({ type: 'setAskUserQuestionnaireCollapsed', toolCallId, collapsed }) }
  async dispose(): Promise<void> {
    this.#disposed = true
    this.#cancelEditorTimer()
    this.#unsubscribe()
    this.#listeners.clear()
  }

  #unpinSelectedSession(): void {
    this.#navigationGeneration += 1
    this.#selectedSession = undefined
    this.#localSelection = undefined
  }
}

const MAX_REMOTE_TRANSCRIPT_CACHE = 16

function rememberTranscriptCache(
  cache: Map<string, { messages: WorkbenchState['messages']; hasOlder: boolean }>,
  path: string,
  messages: WorkbenchState['messages'],
  hasOlder: boolean,
): void {
  cache.delete(path)
  cache.set(path, { messages, hasOlder })
  while (cache.size > MAX_REMOTE_TRANSCRIPT_CACHE) {
    const oldest = cache.keys().next().value
    if (!oldest) break
    cache.delete(oldest)
  }
}
