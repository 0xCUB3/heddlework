import type { AgentTransport, TransportStatus } from '../pi/transport.ts'
import {
  errorMessage,
  isExtensionUiRequest,
  type ExtensionUiRequest,
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

export class WorkbenchController {
  readonly #transport: AgentTransport
  readonly #listeners = new Set<() => void>()
  #state: WorkbenchState
  #started = false
  #connecting = false
  #refreshTimer: ReturnType<typeof setTimeout> | undefined
  #dialogTimer: ReturnType<typeof setTimeout> | undefined
  #unsubscribeEvent: () => void
  #unsubscribeStatus: () => void

  constructor(transport: AgentTransport, workspacePath: string) {
    this.#transport = transport
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
    if (!message || this.#state.connection !== 'connected') return
    const wasStreaming = this.#state.session.isStreaming
    this.#patch({ editorText: '' })
    if (!wasStreaming) {
      const optimistic: PiMessage = {
        role: 'user',
        content: message,
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
        ...(wasStreaming ? { streamingBehavior: 'steer' } : {}),
      })
      if (wasStreaming) this.#setState((state) => addNotice(state, 'info', 'Steering message queued'))
    } catch (error) {
      this.#patch({ editorText: message })
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
      this.#patch({ messages: [], liveAssistant: undefined, liveTools: [], editorText: '' })
      await this.#bootstrap(false)
    } catch (error) {
      this.#setState((state) => addNotice(state, 'error', errorMessage(error)))
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

  dismissNotice(id: number): void {
    this.#patch({ notices: this.#state.notices.filter((notice) => notice.id !== id) })
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
    const tasks = await Promise.allSettled([
      this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' }),
      includeModels
        ? this.#transport.request<{ models: PiModel[] }>({ type: 'get_available_models' })
        : Promise.resolve({ models: this.#state.models }),
      this.#getThinkingLevels(),
      this.#transport.request<PiSessionStats>({ type: 'get_session_stats' }),
    ])
    const [messagesResult, modelsResult, levelsResult, statsResult] = tasks
    this.#patch({
      connection: 'connected',
      connectionMessage: 'Connected',
      session,
      messages: messagesResult.status === 'fulfilled' ? messagesResult.value.messages : this.#state.messages,
      models: modelsResult.status === 'fulfilled' ? modelsResult.value.models : this.#state.models,
      thinkingLevels: levelsResult.status === 'fulfilled' ? levelsResult.value : this.#state.thinkingLevels,
      stats: statsResult.status === 'fulfilled' ? statsResult.value : this.#state.stats,
      liveAssistant: undefined,
      liveTools: [],
      activity: session.isStreaming ? 'Working' : 'Ready',
    })
  }

  async #getThinkingLevels(): Promise<ThinkingLevel[]> {
    const data = await this.#transport.request<{ levels: ThinkingLevel[] }>({ type: 'get_available_thinking_levels' })
    return data.levels
  }

  async #refreshMessages(): Promise<void> {
    try {
      const data = await this.#transport.request<{ messages: PiMessage[] }>({ type: 'get_messages' })
      this.#patch({ messages: data.messages, liveAssistant: undefined, liveTools: [] })
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
      void (full ? this.#bootstrap(false) : Promise.all([this.#refreshMessages(), this.#refreshStats()]))
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
      this.#patch({ windowTitle: request.title ?? 'π Workbench' })
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
