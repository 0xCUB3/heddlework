import { resolve } from 'node:path'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import {
  PiSessionHistoryPager,
  SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES,
  SESSION_HISTORY_PAGE_MAX_MESSAGES,
  SESSION_HISTORY_PAGE_MESSAGES,
  type SessionHistoryPage,
} from '../pi/session-history.ts'
import type { AgentTransport, TransportStatus } from '../pi/transport.ts'
import {
  errorMessage,
  isExtensionUiRequest,
  type ComposerImage,
  type ExtensionUiRequest,
  type PiForkMessage,
  type PiMessage,
  type PiModel,
  type PiSessionState,
  type PiSessionStats,
  type RpcRecord,
  type ThinkingLevel,
} from '../pi/types.ts'
import {
  addNotice,
  applyRpcEvent,
  createInitialState,
  type ExtensionDialog,
  type ExtensionWidget,
  type WorkbenchState,
} from './state.ts'
import { createQueueState, moveQueuedInput, parseQueuedControl, type QueuedControl, type QueuedInput } from './queue.ts'
import type { SessionCatalogService, WorkspaceDiffService } from './services.ts'

const SESSION_PAGE_SIZE = 120
const HISTORY_NAVIGATION_LOAD_OPTIONS = {
  minimumConversationMessages: SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES,
  maximumMessages: SESSION_HISTORY_PAGE_MAX_MESSAGES,
} as const

export interface WorkbenchControllerDependencies {
  sessionCatalog: SessionCatalogService
  workspaceDiff: WorkspaceDiffService
  transportEvents?: 'direct' | 'external'
  transportOwnership?: 'controller' | 'provider'
}

export class WorkbenchController {
  readonly #transport: AgentTransport
  readonly #sessionCatalog: SessionCatalogService
  readonly #workspaceDiff: WorkspaceDiffService
  readonly #stopTransportOnDispose: boolean
  readonly #listeners = new Set<() => void>()
  #state: WorkbenchState
  #started = false
  #connecting = false
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #dialogTimer: ReturnType<typeof setTimeout> | undefined
  #sessionLimit = SESSION_PAGE_SIZE
  #sessionRefresh: Promise<void> | undefined
  #sessionTransitionDepth = 0
  #historyPager: PiSessionHistoryPager | undefined
  #nextQueueId = 0
  #queueDispatch: Promise<void> | undefined
  #unsubscribeEvent: () => void
  #unsubscribeStatus: () => void

  constructor(transport: AgentTransport, workspacePath: string, dependencies: WorkbenchControllerDependencies) {
    this.#transport = transport
    this.#sessionCatalog = dependencies.sessionCatalog
    this.#workspaceDiff = dependencies.workspaceDiff
    this.#stopTransportOnDispose = dependencies.transportOwnership !== 'provider'
    this.#state = createInitialState(workspacePath)
    const cachedSessions = this.#sessionCatalog.cached?.(workspacePath, this.#sessionLimit + 1) ?? []
    if (cachedSessions.length > 0) {
      this.#state = { ...this.#state, sessions: cachedSessions.slice(0, this.#sessionLimit), sessionsLoading: true, sessionsHasMore: cachedSessions.length > this.#sessionLimit }
    }
    if (dependencies.transportEvents === 'external') {
      this.#unsubscribeEvent = () => undefined
      this.#unsubscribeStatus = () => undefined
    } else {
      this.#unsubscribeEvent = transport.onEvent(this.acceptAgentEvent)
      this.#unsubscribeStatus = transport.onStatus(this.acceptAgentStatus)
    }
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): WorkbenchState => this.#state

  readonly loadEarlierMessages = async (): Promise<void> => {
    const pager = this.#historyPager
    if (!pager || !this.#state.messagesHasOlder || this.#state.messagesLoadingEarlier) return
    this.#patch({ messagesLoadingEarlier: true })
    try {
      const page = await pager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
      if (pager !== this.#historyPager) return
      const known = new Set(this.#state.messages.flatMap((message) => messageEntryId(message) ? [messageEntryId(message)!] : []))
      const older = page.messages.filter((message) => !known.has(messageEntryId(message) ?? ''))
      this.#patch({
        messages: [...older, ...this.#state.messages],
        messagesHasOlder: page.hasOlder,
        messagesLoadingEarlier: false,
      })
    } catch (error) {
      if (pager !== this.#historyPager) return
      this.#patch({ messagesHasOlder: false, messagesLoadingEarlier: false })
      this.#setState((state) => addNotice(state, 'warning', `Could not load earlier transcript: ${errorMessage(error)}`))
    }
  }

  readonly acceptAgentEvent = (event: RpcRecord): void => this.#handleEvent(event)
  readonly acceptAgentStatus = (status: TransportStatus): void => this.#handleStatus(status)

  async start(): Promise<void> {
    if (this.#started || this.#connecting) return
    this.#connecting = true
    this.#patch({ connection: 'connecting', connectionMessage: 'Starting Pi…' })
    void this.refreshSessions()
    try {
      await this.#transport.start()
      this.#started = true
      await this.#bootstrap(true)
    } catch (error) {
      this.#patch({
        connection: 'error',
        connectionMessage: errorMessage(error),
      })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    } finally {
      this.#connecting = false
    }
  }

  async reconnect(): Promise<void> {
    this.#started = false
    await this.#transport.stop()
    await this.start()
  }

  async submit(text: string, options: { queue?: boolean } = {}): Promise<void> {
    const message = text.trim()
    const editorImages = this.#state.editorImages
    if ((!message && editorImages.length === 0) || this.#state.connection !== 'connected') return
    if (this.#state.session.isStreaming || options.queue) {
      this.#patch({ editorText: '', editorImages: [] })
      this.queueInput(message, editorImages, { paused: Boolean(options.queue && !this.#state.session.isStreaming) })
      return
    }
    this.#patch({ editorText: '', editorImages: [] })
    await this.#sendPrompt(message, editorImages, true)
  }

  queueInput(text: string, images: readonly ComposerImage[] = [], options: { paused?: boolean } = {}): QueuedInput | undefined {
    const message = text.trim()
    if (!message && images.length === 0) return undefined
    const item: QueuedInput = {
      id: `queue-${Date.now()}-${++this.#nextQueueId}`,
      text: message,
      images: images.map((image) => ({ ...image })),
      createdAt: Date.now(),
    }
    const resetPause = this.#state.queue.items.length === 0 && !options.paused
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: [...this.#state.queue.items, item],
        ...(options.paused ? { paused: true, pauseReason: 'manual' as const } : {}),
        ...(resetPause ? { paused: false, pauseReason: undefined } : {}),
      },
    })
    return item
  }

  updateQueuedInput(id: string, text: string): void {
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item || this.#state.queue.dispatchingId === id) return
    const message = text.trim()
    if (!message && item.images.length === 0) {
      this.removeQueuedInput(id)
      return
    }
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.map((candidate) => candidate.id === id ? { ...candidate, text: message } : candidate),
      },
    })
  }

  removeQueuedInput(id: string): void {
    if (this.#state.queue.dispatchingId === id) return
    const items = this.#state.queue.items.filter((item) => item.id !== id)
    this.#patch({ queue: { ...this.#state.queue, items, ...(items.length === 0 ? { paused: false, pauseReason: undefined } : {}) } })
  }

  moveQueuedInput(id: string, targetIndex: number): void {
    if (this.#state.queue.dispatchingId) return
    this.#patch({ queue: { ...this.#state.queue, items: moveQueuedInput(this.#state.queue.items, id, targetIndex) } })
  }

  async steerQueuedInput(id: string): Promise<void> {
    const item = this.#state.queue.items.find((candidate) => candidate.id === id)
    if (!item || !this.#state.session.isStreaming || this.#state.queue.dispatchingId) return
    if (item.images.length === 0 && parseQueuedControl(item.text)) return
    this.#patch({ queue: { ...this.#state.queue, dispatchingId: id } })
    try {
      await this.#transport.request({
        type: 'prompt',
        message: item.text,
        ...(item.images.length > 0 ? { images: item.images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
        streamingBehavior: 'steer',
      })
      this.#patch({
        queue: {
          ...this.#state.queue,
          items: this.#state.queue.items.filter((candidate) => candidate.id !== id),
          steering: [item.text || 'Image attachment', ...this.#state.queue.steering.filter((text) => text !== item.text)],
          dispatchingId: undefined,
        },
      })
    } catch (error) {
      this.#patch({ queue: { ...this.#state.queue, dispatchingId: undefined } })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  resumeQueue(): void {
    this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
    this.#drainQueue()
  }

  async abort(): Promise<void> {
    if (this.#state.queue.items.length > 0) this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'abort' } })
    try {
      await this.#transport.request({ type: 'abort' })
      this.#patch({ activity: 'Aborting' })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async newSession(): Promise<void> {
    if (this.#state.session.isStreaming) return
    this.#sessionTransitionDepth += 1
    try {
      if (this.#state.dialog) this.respondToDialog({ cancelled: true })
      const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'new_session' })
      if (result.cancelled) return
      this.#historyPager = undefined
      this.#patch({ messages: [], messagesHasOlder: false, messagesLoadingEarlier: false, forkMessages: [], liveAssistant: undefined, liveTools: [], editorText: '', editorImages: [], notices: [], dialog: undefined, queue: createQueueState() })
      await this.#bootstrap(false)
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    } finally {
      this.#sessionTransitionDepth = Math.max(0, this.#sessionTransitionDepth - 1)
    }
  }

  async switchWorkspace(workspacePath: string): Promise<void> {
    const target = resolve(workspacePath)
    if (this.#state.session.isStreaming || target === resolve(this.#state.workspacePath)) return
    this.#patch({ activity: 'Opening project' })
    try {
      const session = await this.#sessionCatalog.createWorkspaceSession(target)
      await this.switchSession(session)
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', `Could not open project: ${errorMessage(error)}`))
    }
  }

  async switchSession(session: PiSessionSummary): Promise<void> {
    if (
      this.#state.session.isStreaming ||
      session.path === this.#state.session.sessionFile ||
      session.id === this.#state.session.sessionId
    ) return
    this.#sessionTransitionDepth += 1
    try {
      if (this.#state.dialog) this.respondToDialog({ cancelled: true })
      this.#patch({ activity: 'Opening thread' })
      const result = await this.#transport.request<{ cancelled?: boolean }>({
        type: 'switch_session',
        sessionPath: session.path,
      })
      if (result.cancelled) {
        this.#patch({ activity: 'Ready' })
        return
      }
      const workspacePath = session.cwd ? resolve(session.cwd) : this.#state.workspacePath
      this.#historyPager = undefined
      this.#patch({
        workspacePath,
        messages: [],
        messagesHasOlder: false,
        messagesLoadingEarlier: false,
        forkMessages: [],
        liveAssistant: undefined,
        liveTools: [],
        editorText: '',
        editorImages: [],
        notices: [],
        dialog: undefined,
        queue: createQueueState(),
        workspaceDiff: { status: 'idle', branch: '', files: [], additions: 0, deletions: 0 },
      })
      await this.#bootstrap(false)
      void this.refreshSessions()
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    } finally {
      this.#sessionTransitionDepth = Math.max(0, this.#sessionTransitionDepth - 1)
    }
  }

  async refreshSessions(): Promise<void> {
    if (this.#sessionRefresh) return this.#sessionRefresh
    this.#patch({ sessionsLoading: true })
    const task = (async () => {
      try {
        const sessions = await this.#sessionCatalog.list(this.#state.workspacePath, this.#sessionLimit + 1)
        this.#patch({
          sessions: sessions.slice(0, this.#sessionLimit),
          sessionsLoading: false,
          sessionsHasMore: sessions.length > this.#sessionLimit,
        })
      } catch (error) {
        this.#patch({ sessionsLoading: false })
        this.#setState((state) => addNotice(state, 'warning', `Could not list sessions: ${errorMessage(error)}`))
      }
    })().finally(() => {
      if (this.#sessionRefresh === task) this.#sessionRefresh = undefined
    })
    this.#sessionRefresh = task
    return task
  }

  async loadMoreSessions(): Promise<void> {
    if (this.#state.sessionsLoading || !this.#state.sessionsHasMore) return
    this.#sessionLimit += SESSION_PAGE_SIZE
    await this.refreshSessions()
  }

  async cloneSession(): Promise<void> {
    if (this.#state.session.isStreaming) return
    try {
      const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'clone' })
      if (result.cancelled) return
      this.#patch({ notices: [], queue: createQueueState() })
      await this.#bootstrap(false)
      this.#setState((state) => addNotice(state, 'info', 'Cloned thread into a new Pi session'))
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async forkFrom(entryId: string): Promise<void> {
    if (!entryId || this.#state.session.isStreaming) return
    try {
      const result = await this.#transport.request<{ text?: string; cancelled?: boolean }>({ type: 'fork', entryId })
      if (result.cancelled) return
      this.#patch({ notices: [], queue: createQueueState() })
      await this.#bootstrap(false)
      this.#patch({ editorText: result.text ?? '', editorImages: [] })
      this.#setState((state) => addNotice(state, 'info', 'Branched from the selected turn'))
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async exportSession(): Promise<string | undefined> {
    try {
      const data = await this.#transport.request<{ path: string }>({ type: 'export_html' })
      this.#setState((state) => addNotice(state, 'info', `Exported session to ${data.path}`))
      return data.path
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      return undefined
    }
  }

  async setModel(model: PiModel): Promise<void> {
    try {
      await this.#transport.request({ type: 'set_model', provider: model.provider, modelId: model.id })
      const [session, levels] = await Promise.all([
        this.#transport.request<PiSessionState>({ type: 'get_state' }),
        this.#getThinkingLevels(),
      ])
      this.#patch({ session, thinkingLevels: levels })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async setThinkingLevel(level: ThinkingLevel): Promise<void> {
    try {
      await this.#transport.request({ type: 'set_thinking_level', level })
      this.#patch({ session: { ...this.#state.session, thinkingLevel: level } })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async compact(): Promise<void> {
    if (this.#state.session.isStreaming) return
    try {
      this.#patch({ activity: 'Compacting context' })
      await this.#transport.request({ type: 'compact' })
      await this.#refreshStats()
      this.#setState((state) => addNotice({ ...state, activity: 'Ready' }, 'info', 'Context compacted'))
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  setEditorText(text: string): void {
    this.#patch({ editorText: text })
  }

  addEditorImage(image: ComposerImage): void {
    const acceptedInputs = this.#state.session.model?.input
    if (acceptedInputs && !acceptedInputs.includes('image')) {
      this.#setState((state) => addNotice(state, 'warning', 'The selected model does not accept images'))
      return
    }
    if (this.#state.editorImages.some((candidate) => candidate.data === image.data)) return
    if (this.#state.editorImages.length >= 8) {
      this.#setState((state) => addNotice(state, 'warning', 'A prompt can include at most 8 images'))
      return
    }
    this.#patch({ editorImages: [...this.#state.editorImages, image] })
  }

  removeEditorImage(id: string): void {
    this.#patch({ editorImages: this.#state.editorImages.filter((image) => image.id !== id) })
  }

  dismissNotice(id: number): void {
    this.#patch({ notices: this.#state.notices.filter((notice) => notice.id !== id) })
  }

  clearNotices(): void {
    this.#patch({ notices: [] })
  }

  settleThread(path: string): void {
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { settledAt: Date.now() },
    }
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', 'Thread moved to Settled'))
  }

  snoozeThread(path: string, snoozedUntil: number): void {
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { snoozedUntil },
    }
    const time = new Date(snoozedUntil).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', `Snoozed until ${time}`))
  }

  wakeThread(path: string): void {
    const threadLifecycle = {
      ...this.#state.threadLifecycle,
      [path]: { unsettledAt: Date.now() },
    }
    this.#setState((state) => addNotice({ ...state, threadLifecycle }, 'info', 'Thread returned to Active'))
  }

  async refreshWorkspaceDiff(): Promise<void> {
    const workspacePath = this.#state.workspacePath
    this.#patch({
      workspaceDiff: {
        status: 'loading',
        branch: this.#state.workspaceDiff.branch,
        files: this.#state.workspaceDiff.files,
        additions: this.#state.workspaceDiff.additions,
        deletions: this.#state.workspaceDiff.deletions,
      },
    })
    const workspaceDiff = await this.#workspaceDiff.load(workspacePath)
    if (this.#state.workspacePath === workspacePath) this.#patch({ workspaceDiff })
  }

  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    const dialog = this.#state.dialog
    if (!dialog) return
    this.#clearDialogTimer()
    this.#patch({ dialog: undefined })
    try {
      this.#transport.send({ type: 'extension_ui_response', id: dialog.id, ...response })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async dispose(): Promise<void> {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#clearDialogTimer()
    this.#unsubscribeEvent()
    this.#unsubscribeStatus()
    if (this.#stopTransportOnDispose) await this.#transport.stop()
    this.#listeners.clear()
  }

  async #sendPrompt(message: string, images: readonly ComposerImage[], restoreDraft: boolean): Promise<boolean> {
    const previousMessages = this.#state.messages
    const previousSession = this.#state.session
    const previousActivity = this.#state.activity
    const optimisticContent = images.length > 0
      ? [
          ...(message ? [{ type: 'text' as const, text: message }] : []),
          ...images.map(({ data, mimeType, previewPath }) => ({ type: 'image' as const, data, mimeType, previewPath })),
        ]
      : message
    const optimistic: PiMessage = {
      role: 'user',
      content: optimisticContent,
      timestamp: Date.now(),
      workbenchOptimistic: true,
    }
    this.#patch({
      messages: [...previousMessages, optimistic],
      session: { ...previousSession, isStreaming: true },
      activity: 'Sending',
    })
    try {
      await this.#transport.request({
        type: 'prompt',
        message,
        ...(images.length > 0 ? { images: images.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType })) } : {}),
      })
      return true
    } catch (error) {
      this.#patch({
        messages: previousMessages,
        session: previousSession,
        activity: previousActivity,
        ...(restoreDraft ? { editorText: message, editorImages: images.map((image) => ({ ...image })) } : {}),
      })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      this.#scheduleRefresh(true)
      return false
    }
  }

  #drainQueue(): void {
    if (this.#queueDispatch) return
    const task = this.#drainQueueHead()
    this.#queueDispatch = task
    void task.finally(() => {
      if (this.#queueDispatch !== task) return
      this.#queueDispatch = undefined
      if (!this.#state.session.isStreaming && !this.#state.queue.paused && this.#state.queue.items.length > 0) queueMicrotask(() => this.#drainQueue())
    })
  }

  async #drainQueueHead(): Promise<void> {
    const { queue, session, connection } = this.#state
    if (queue.paused || queue.dispatchingId || session.isStreaming || connection !== 'connected') return
    const item = queue.items[0]
    if (!item) return
    this.#patch({ queue: { ...queue, dispatchingId: item.id } })
    const control = item.images.length === 0 ? parseQueuedControl(item.text) : undefined
    const accepted = control
      ? await this.#runQueuedControl(control)
      : await this.#sendPrompt(item.text, item.images, false)
    if (!accepted) {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error', dispatchingId: undefined } })
      return
    }
    this.#patch({
      queue: {
        ...this.#state.queue,
        items: this.#state.queue.items.filter((candidate) => candidate.id !== item.id),
        dispatchingId: undefined,
      },
    })
    if (!control && item.text.startsWith('/')) this.#scheduleRefresh(true)
  }

  async #runQueuedControl(control: QueuedControl): Promise<boolean> {
    try {
      if (control.kind === 'compact') {
        this.#patch({ activity: 'Compacting context' })
        await this.#transport.request({ type: 'compact', ...(control.instructions ? { customInstructions: control.instructions } : {}) })
        this.#patch({ activity: 'Ready' })
        return true
      }
      if (control.kind === 'new') {
        const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'new_session' })
        if (result.cancelled) return false
        if (this.#state.dialog) this.respondToDialog({ cancelled: true })
        this.#historyPager = undefined
        this.#patch({
          messages: [],
          messagesHasOlder: false,
          messagesLoadingEarlier: false,
          forkMessages: [],
          liveAssistant: undefined,
          liveTools: [],
          editorText: '',
          editorImages: [],
          notices: [],
          dialog: undefined,
          queue: { ...this.#state.queue, steering: [], followUp: [] },
        })
        await this.#bootstrap(false)
        return true
      }
      if (control.kind === 'model') {
        const separator = control.target?.indexOf('/') ?? -1
        if (!control.target || separator <= 0 || separator === control.target.length - 1) {
          this.#setState((state) => addNotice(state, 'warning', 'Queued /model requires provider/model'))
          return false
        }
        await this.#transport.request({ type: 'set_model', provider: control.target.slice(0, separator), modelId: control.target.slice(separator + 1) })
        await this.#bootstrap(false)
        return true
      }
      if (control.kind === 'thinking') {
        if (!control.level || !this.#state.thinkingLevels.includes(control.level as ThinkingLevel)) {
          this.#setState((state) => addNotice(state, 'warning', 'Queued /thinking requires a supported level'))
          return false
        }
        await this.#transport.request({ type: 'set_thinking_level', level: control.level })
        await this.#bootstrap(false)
        return true
      }
      const sessionFile = this.#state.session.sessionFile
      if (!sessionFile) {
        this.#setState((state) => addNotice(state, 'warning', 'Queued /reload requires a persisted Pi session'))
        return false
      }
      this.#connecting = true
      try {
        this.#started = false
        this.#patch({ queue: { ...this.#state.queue, steering: [], followUp: [] } })
        await this.#transport.stop()
        await this.#transport.start()
        this.#started = true
        const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'switch_session', sessionPath: sessionFile })
        if (result.cancelled) {
          await this.#bootstrap(false)
          return false
        }
        await this.#bootstrap(false)
      } finally {
        this.#connecting = false
      }
      return true
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      return false
    }
  }

  async #bootstrap(includeModels: boolean): Promise<void> {
    const session = await this.#transport.request<PiSessionState>({ type: 'get_state' })
    this.#patch({
      connection: 'connected',
      connectionMessage: 'Connected',
      session,
      liveAssistant: undefined,
      liveTools: [],
      activity: session.isStreaming ? 'Working' : 'Ready',
    })
    const tasks = await Promise.allSettled([
      this.#loadInitialTranscript(session),
      includeModels
        ? this.#transport.request<{ models: PiModel[] }>({ type: 'get_available_models' })
        : Promise.resolve({ models: this.#state.models }),
      this.#getThinkingLevels(),
      this.#transport.request<PiSessionStats>({ type: 'get_session_stats' }),
      this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' }),
    ])
    const [messagesResult, modelsResult, levelsResult, statsResult, forkMessagesResult] = tasks
    if (messagesResult.status === 'fulfilled') this.#historyPager = messagesResult.value.pager
    this.#patch({
      messages: messagesResult.status === 'fulfilled' ? messagesResult.value.page.messages : this.#state.messages,
      messagesHasOlder: messagesResult.status === 'fulfilled' ? messagesResult.value.page.hasOlder : false,
      messagesLoadingEarlier: false,
      forkMessages: forkMessagesResult.status === 'fulfilled' ? forkMessagesFrom(forkMessagesResult.value) : this.#state.forkMessages,
      models: modelsResult.status === 'fulfilled' ? modelsResult.value.models : this.#state.models,
      thinkingLevels: levelsResult.status === 'fulfilled' ? levelsResult.value : this.#state.thinkingLevels,
      stats: statsResult.status === 'fulfilled' ? statsResult.value : this.#state.stats,
    })
    void this.refreshWorkspaceDiff()
    if (!session.isStreaming) queueMicrotask(() => this.#drainQueue())
  }

  async #loadInitialTranscript(session: PiSessionState): Promise<{ page: SessionHistoryPage; pager: PiSessionHistoryPager | undefined }> {
    if (session.sessionFile) {
      const pager = new PiSessionHistoryPager(session.sessionFile)
      try {
        const page = await pager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS)
        return { page, pager }
      } catch {
        // Fall through to RPC for unsaved, unavailable, or legacy sessions.
      }
    }
    const result = await this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
    return { page: { messages: result.messages, hasOlder: false }, pager: undefined }
  }

  async #getThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = await this.#transport.request<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' })
    return data.levels
  }

  async #refreshMessages(): Promise<void> {
    try {
      const sessionFile = this.#state.session.sessionFile
      const forkMessagesPromise = this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' })
      if (sessionFile) {
        const latestPager = new PiSessionHistoryPager(sessionFile)
        const [page, forkMessages] = await Promise.all([latestPager.loadEarlier(SESSION_HISTORY_PAGE_MESSAGES, HISTORY_NAVIGATION_LOAD_OPTIONS), forkMessagesPromise])
        const retainedPager = this.#historyPager
        if (!retainedPager) this.#historyPager = latestPager
        this.#patch({
          messages: mergeTranscriptTail(this.#state.messages, page.messages),
          messagesHasOlder: retainedPager ? this.#state.messagesHasOlder : page.hasOlder,
          messagesLoadingEarlier: false,
          forkMessages: forkMessagesFrom(forkMessages),
          liveAssistant: undefined,
          liveTools: [],
        })
        return
      }
      const [messages, forkMessages] = await Promise.all([
        this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' }),
        forkMessagesPromise,
      ])
      this.#patch({ messages: messages.messages, messagesHasOlder: false, messagesLoadingEarlier: false, forkMessages: forkMessagesFrom(forkMessages), liveAssistant: undefined, liveTools: [] })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'warning', `Could not refresh transcript: ${errorMessage(error)}`))
    }
  }

  async #refreshStats(): Promise<void> {
    try {
      const stats = await this.#transport.request<PiSessionStats>({ type: 'get_session_stats' })
      this.#patch({ stats })
    } catch {
      // Stats are supplementary; transcript operation should continue without them.
    }
  }

  #scheduleRefresh(full: boolean): void {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#refreshTimer = setTimeout(() => {
      this.#refreshTimer = undefined
      void (full ? Promise.all([this.#bootstrap(false), this.refreshSessions()]) : Promise.all([this.#refreshMessages(), this.#refreshStats()]))
    }, full ? 80 : 35)
  }

  #handleEvent(event: RpcRecord): void {
    if (isExtensionUiRequest(event)) {
      this.#handleExtensionUi(event)
      return
    }
    this.#setState((state) => applyRpcEvent(state, event))
    const runOutcome = event.type === 'agent_end' && !event.willRetry ? agentEndOutcome(event) : 'unknown'
    if (runOutcome === 'failed') {
      this.#patch({ queue: { ...this.#state.queue, paused: true, pauseReason: 'error' } })
    } else if (runOutcome === 'healthy' && this.#state.queue.pauseReason === 'error') {
      this.#patch({ queue: { ...this.#state.queue, paused: false, pauseReason: undefined } })
    }
    if (event.type === 'message_end' || event.type === 'tool_execution_end') this.#scheduleRefresh(false)
    if (event.type === 'agent_settled') {
      this.#scheduleRefresh(true)
      this.#drainQueue()
    }
  }

  #handleExtensionUi(request: ExtensionUiRequest): void {
    if (this.#sessionTransitionDepth > 0) {
      if (request.method === 'select' || request.method === 'confirm' || request.method === 'input' || request.method === 'editor') {
        try {
          this.#transport.send({ type: 'extension_ui_response', id: request.id, cancelled: true })
        } catch {
          // The abandoned session no longer owns visible UI; switching remains authoritative.
        }
      }
      return
    }
    if (request.method === 'notify') {
      this.#setState((state) => addNotice(state, request.notifyType ?? 'info', request.message ?? 'Pi notification'))
      return
    }
    if (request.method === 'setStatus') {
      const key = request.statusKey ?? request.id
      const statusItems = { ...this.#state.statusItems }
      if (request.statusText) statusItems[key] = request.statusText
      else delete statusItems[key]
      this.#patch({ statusItems })
      return
    }
    if (request.method === 'setWidget') {
      const key = request.widgetKey ?? request.id
      const widgets = { ...this.#state.widgets }
      if (request.widgetLines) {
        const widget: ExtensionWidget = {
          key,
          lines: request.widgetLines,
          placement: request.widgetPlacement ?? 'aboveEditor',
        }
        widgets[key] = widget
      } else {
        delete widgets[key]
      }
      this.#patch({ widgets })
      return
    }
    if (request.method === 'setTitle') {
      this.#patch({ windowTitle: request.title ?? 'Heddlework' })
      return
    }
    if (request.method === 'set_editor_text') {
      this.#patch({ editorText: request.text ?? '' })
      return
    }

    const dialog: ExtensionDialog = {
      id: request.id,
      method: request.method,
      title: request.title ?? 'Pi needs your input',
      ...(request.message === undefined ? {} : { message: request.message }),
      ...(request.options === undefined ? {} : { options: request.options }),
      ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
      ...(request.prefill === undefined ? {} : { prefill: request.prefill }),
      ...(request.timeout === undefined ? {} : { timeout: request.timeout }),
    }
    this.#patch({ dialog })
    this.#clearDialogTimer()
    if (request.timeout) {
      this.#dialogTimer = setTimeout(() => {
        if (this.#state.dialog?.id === request.id) this.#patch({ dialog: undefined })
      }, request.timeout + 50)
    }
  }

  #handleStatus(status: TransportStatus): void {
    if (status.state === 'starting') this.#patch({ connection: 'connecting', connectionMessage: 'Starting Pi…' })
    if (status.state === 'running') this.#patch({ connectionMessage: `Pi process ${status.pid ?? ''}`.trim() })
    if (status.state === 'stopped' && !this.#connecting) this.#patch({ connection: 'idle', connectionMessage: 'Disconnected' })
    if (status.state === 'exited') {
      this.#started = false
      this.#patch({
        connection: 'error',
        connectionMessage: status.message,
        session: { ...this.#state.session, isStreaming: false },
        activity: 'Disconnected',
      })
    }
  }

  #clearDialogTimer(): void {
    if (this.#dialogTimer) clearTimeout(this.#dialogTimer)
    this.#dialogTimer = undefined
  }

  #patch(patch: Partial<WorkbenchState>): void {
    this.#setState((state) => ({ ...state, ...patch }))
  }

  #setState(update: (state: WorkbenchState) => WorkbenchState): void {
    const next = update(this.#state)
    if (next === this.#state) return
    this.#state = next
    for (const listener of this.#listeners) listener()
  }
}

function messageEntryId(message: PiMessage): string | undefined {
  return typeof message.workbenchEntryId === 'string' ? message.workbenchEntryId : undefined
}

function mergeTranscriptTail(current: PiMessage[], latest: PiMessage[]): PiMessage[] {
  if (latest.length === 0) return current
  const latestIds = new Set(latest.flatMap((message) => messageEntryId(message) ? [messageEntryId(message)!] : []))
  const overlap = current.findIndex((message) => latestIds.has(messageEntryId(message) ?? ''))
  const prefix = overlap >= 0 ? current.slice(0, overlap) : current.filter((message) => messageEntryId(message) !== undefined)
  const seen = new Set<string>()
  return [...prefix, ...latest].filter((message) => {
    const id = messageEntryId(message)
    if (!id) return true
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

function agentEndOutcome(event: RpcRecord): 'healthy' | 'failed' | 'unknown' {
  if (!Array.isArray(event.messages)) return 'unknown'
  for (let index = event.messages.length - 1; index >= 0; index -= 1) {
    const message = event.messages[index]
    if (!message || typeof message !== 'object' || (message as { role?: unknown }).role !== 'assistant') continue
    const stopReason = (message as { stopReason?: unknown }).stopReason
    return stopReason === 'error' || stopReason === 'aborted' ? 'failed' : 'healthy'
  }
  return 'unknown'
}

function forkMessagesFrom(value: unknown): PiForkMessage[] {
  if (!value || typeof value !== 'object') return []
  const messages = (value as { messages?: unknown }).messages
  if (!Array.isArray(messages)) return []
  return messages.filter((message): message is PiForkMessage => (
    Boolean(message)
    && typeof message === 'object'
    && typeof (message as { entryId?: unknown }).entryId === 'string'
    && typeof (message as { text?: unknown }).text === 'string'
  ))
}
