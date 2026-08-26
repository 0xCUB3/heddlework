import { resolve } from 'node:path'
import { PiSessionCatalog, type PiSessionSummary } from '../pi/session-catalog.ts'
import type { AgentTransport, TransportStatus } from '../pi/transport.ts'
import { loadWorkspaceDiff } from '../workspace/git-diff.ts'
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

const SESSION_PAGE_SIZE = 120

export class WorkbenchController {
  readonly #transport: AgentTransport
  readonly #sessionCatalog: PiSessionCatalog
  readonly #listeners = new Set<() => void>()
  #state: WorkbenchState
  #started = false
  #connecting = false
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #dialogTimer: ReturnType<typeof setTimeout> | undefined
  #sessionLimit = SESSION_PAGE_SIZE
  #sessionRefresh: Promise<void> | undefined
  #unsubscribeEvent: () => void
  #unsubscribeStatus: () => void

  constructor(transport: AgentTransport, workspacePath: string, sessionCatalog = new PiSessionCatalog()) {
    this.#transport = transport
    this.#sessionCatalog = sessionCatalog
    this.#state = createInitialState(workspacePath)
    this.#unsubscribeEvent = transport.onEvent((event) => this.#handleEvent(event))
    this.#unsubscribeStatus = transport.onStatus((status) => this.#handleStatus(status))
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly getSnapshot = (): WorkbenchState => this.#state

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

  async submit(text: string): Promise<void> {
    const message = text.trim()
    const editorImages = this.#state.editorImages
    if ((!message && editorImages.length === 0) || this.#state.connection !== 'connected') return
    const wasStreaming = this.#state.session.isStreaming
    const rpcImages = editorImages.map(({ data, mimeType }) => ({ type: 'image' as const, data, mimeType }))
    const optimisticContent = editorImages.length > 0
      ? [
          ...(message ? [{ type: 'text', text: message }] : []),
          ...editorImages.map(({ data, mimeType, previewPath }) => ({ type: 'image', data, mimeType, previewPath })),
        ]
      : message
    this.#patch({ editorText: '', editorImages: [] })
    if (!wasStreaming) {
      const optimistic: PiMessage = {
        role: 'user',
        content: optimisticContent,
        timestamp: Date.now(),
        workbenchOptimistic: true,
      }
      this.#patch({
        messages: [...this.#state.messages, optimistic],
        session: { ...this.#state.session, isStreaming: true },
        activity: 'Sending',
      })
    }
    try {
      await this.#transport.request({
        type: 'prompt',
        message,
        ...(rpcImages.length > 0 ? { images: rpcImages } : {}),
        ...(wasStreaming ? { streamingBehavior: 'steer' } : {}),
      })
      if (wasStreaming) this.#setState((state) => addNotice(state, 'info', 'Steering message queued'))
    } catch (error) {
      this.#patch({ editorText: message, editorImages })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
      this.#scheduleRefresh(true)
    }
  }

  async abort(): Promise<void> {
    try {
      await this.#transport.request({ type: 'abort' })
      this.#patch({ activity: 'Aborting' })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async newSession(): Promise<void> {
    if (this.#state.session.isStreaming) return
    try {
      const result = await this.#transport.request<{ cancelled?: boolean }>({ type: 'new_session' })
      if (result.cancelled) return
      if (this.#state.dialog) this.respondToDialog({ cancelled: true })
      this.#patch({ messages: [], forkMessages: [], liveAssistant: undefined, liveTools: [], editorText: '', editorImages: [], notices: [], dialog: undefined })
      await this.#bootstrap(false)
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async switchSession(session: PiSessionSummary): Promise<void> {
    if (
      this.#state.session.isStreaming ||
      session.path === this.#state.session.sessionFile ||
      session.id === this.#state.session.sessionId
    ) return
    try {
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
      if (this.#state.dialog) this.respondToDialog({ cancelled: true })
      this.#patch({
        workspacePath,
        messages: [],
        forkMessages: [],
        liveAssistant: undefined,
        liveTools: [],
        editorText: '',
        editorImages: [],
        notices: [],
        dialog: undefined,
        workspaceDiff: { status: 'idle', branch: '', files: [], additions: 0, deletions: 0 },
      })
      await this.#bootstrap(false)
      void this.refreshSessions()
    } catch (error) {
      this.#patch({ activity: 'Ready' })
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
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
      this.#patch({ notices: [] })
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
      this.#patch({ notices: [] })
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
    const workspaceDiff = await loadWorkspaceDiff(workspacePath)
    if (this.#state.workspacePath === workspacePath) this.#patch({ workspaceDiff })
  }

  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void {
    const dialog = this.#state.dialog
    if (!dialog) return
    this.#clearDialogTimer()
    try {
      this.#transport.send({ type: 'extension_ui_response', id: dialog.id, ...response })
      this.#patch({ dialog: undefined })
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
    }
  }

  async dispose(): Promise<void> {
    if (this.#refreshTimer) clearTimeout(this.#refreshTimer)
    this.#clearDialogTimer()
    this.#unsubscribeEvent()
    this.#unsubscribeStatus()
    await this.#transport.stop()
    this.#listeners.clear()
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
      this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' }),
      includeModels
        ? this.#transport.request<{ models: PiModel[] }>({ type: 'get_available_models' })
        : Promise.resolve({ models: this.#state.models }),
      this.#getThinkingLevels(),
      this.#transport.request<PiSessionStats>({ type: 'get_session_stats' }),
      this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' }),
    ])
    const [messagesResult, modelsResult, levelsResult, statsResult, forkMessagesResult] = tasks
    this.#patch({
      messages: messagesResult.status === 'fulfilled' ? messagesResult.value.messages : this.#state.messages,
      forkMessages: forkMessagesResult.status === 'fulfilled' ? forkMessagesFrom(forkMessagesResult.value) : this.#state.forkMessages,
      models: modelsResult.status === 'fulfilled' ? modelsResult.value.models : this.#state.models,
      thinkingLevels: levelsResult.status === 'fulfilled' ? levelsResult.value : this.#state.thinkingLevels,
      stats: statsResult.status === 'fulfilled' ? statsResult.value : this.#state.stats,
    })
    void this.refreshWorkspaceDiff()
  }

  async #getThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = await this.#transport.request<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' })
    return data.levels
  }

  async #refreshMessages(): Promise<void> {
    try {
      const [messages, forkMessages] = await Promise.all([
        this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' }),
        this.#transport.request<{ messages: PiForkMessage[] }>({ type: 'get_fork_messages' }),
      ])
      this.#patch({ messages: messages.messages, forkMessages: forkMessagesFrom(forkMessages), liveAssistant: undefined, liveTools: [] })
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
    if (event.type === 'message_end' || event.type === 'tool_execution_end') this.#scheduleRefresh(false)
    if (event.type === 'agent_settled') this.#scheduleRefresh(true)
  }

  #handleExtensionUi(request: ExtensionUiRequest): void {
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
      this.#patch({ windowTitle: request.title ?? 'π Code' })
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
