import type { BrowserSessionService } from '../browser/service.ts'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import type { SleepPreventionService } from '../power/service.ts'
import type { PluginHost } from '../plugins/host.ts'
import type { UpdateService } from '../updates/service.ts'
import type { TerminalSessionService } from '../terminal/service.ts'
import { RemoteWorkbenchController } from '../dom/remote-controller.ts'
import type { WorkbenchControllerSurface } from '../workbench/controller-surface.ts'
import { PresenceRegistry } from '../workbench/presence.ts'
import { createInitialState, type NoticeKind, type NoticeOptions, type ThreadPriority, type WorkbenchState } from '../workbench/state.ts'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { ComposerImage, PiModel, RpcRecord, ThinkingLevel } from '../pi/types.ts'
import type { TransportStatus } from '../pi/transport.ts'
import type { AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { MutationReceipt } from '../receipts/types.ts'
import type { ThreadTitleSettings } from '../workbench/thread-titles.ts'
import type { QueueInputDraft, QueuedInput, QueueLane } from '../workbench/queue.ts'
import type { NavigateTreeOptions } from '../workbench/controller.ts'
import { WorkspaceClient, type WorkspaceClientView } from '../web/client.ts'
import { ClientFlowRuntime } from './client-flow-runtime.ts'
import type { FlowRuntimeSurface } from '../flows/runtime.ts'
import {
  RuntimeSettingsControl,
  createRuntimeRemoteSettingsFacades,
  type RuntimeRemoteAccessFacade,
  type RuntimeRemoteSettingsFacades,
  type RuntimeTailnetServeFacade,
} from './runtime-settings-control.ts'
import { createClientBrowserIntegrationService, createClientSleepPreventionService } from './client-runtime-services.ts'

/** Credentials the native shell receives from the supervised runtime agent (LaunchAgent / attach-or-start). */
export interface RuntimeAttachDescriptor {
  workspaceUrl: string
  token: string
  hostUrls?: readonly string[] | undefined
  /** HTTP control plane base URL; defaults to workspaceUrl. */
  controlUrl?: string | undefined
}

export interface AttachRuntimeClientOptions {
  client?: WorkspaceClient | undefined
  alternates?: readonly string[] | undefined
}

export function attachRuntimeWorkspaceClient(
  descriptor: RuntimeAttachDescriptor,
  options: AttachRuntimeClientOptions = {},
): WorkspaceClient {
  const client = options.client ?? new WorkspaceClient()
  const alternates = options.alternates ?? descriptor.hostUrls ?? []
  client.connect(descriptor.workspaceUrl, descriptor.token, alternates)
  return client
}

export interface WaitForWorkspaceClientOpenOptions {
  signal?: AbortSignal | undefined
  timeoutMs?: number | undefined
}

export function waitForWorkspaceClientOpen(
  client: WorkspaceClient,
  options: WaitForWorkspaceClientOpenOptions = {},
): Promise<WorkspaceClientView> {
  const snapshot = client.getSnapshot()
  if (snapshot.status === 'open' && snapshot.state) return Promise.resolve(snapshot)

  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? 120_000
    let timeout: ReturnType<typeof setTimeout> | undefined
    const unsubscribe = client.subscribe(() => {
      const view = client.getSnapshot()
      if (view.status === 'open' && view.state) {
        cleanup()
        resolve(view)
      }
    })
    const onAbort = (): void => {
      cleanup()
      reject(options.signal?.reason ?? new Error('Aborted'))
    }
    const cleanup = (): void => {
      unsubscribe()
      if (timeout) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
    }
    if (options.signal?.aborted) {
      onAbort()
      return
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Timed out waiting for workspace connection'))
    }, timeoutMs)
    timeout.unref?.()
  })
}

export interface RemoteClientServicesOptions {
  /** GPUIX native browser stays in the desktop process. */
  browsers: BrowserSessionService
  updates?: UpdateService | undefined
  pluginHost?: PluginHost | undefined
  control?: RuntimeSettingsControl | undefined
  terminals?: TerminalSessionService | undefined
  timeoutMs?: number | undefined
}

export interface RemoteClientServices {
  client: WorkspaceClient
  controller: WorkbenchControllerSurface
  flows: FlowRuntimeSurface
  remoteAccess: RuntimeRemoteAccessFacade
  tailnetServe: RuntimeTailnetServeFacade
  browserIntegrations: BrowserIntegrationService
  sleepPrevention: SleepPreventionService
  browsers: BrowserSessionService
  terminals?: TerminalSessionService | undefined
  updates?: UpdateService | undefined
  pluginHost?: PluginHost | undefined
  settings: RuntimeRemoteSettingsFacades
  dispose(): Promise<void>
}

export async function createRemoteServices(
  client: WorkspaceClient,
  descriptor: RuntimeAttachDescriptor,
  options: RemoteClientServicesOptions,
): Promise<RemoteClientServices> {
  await waitForWorkspaceClientOpen(client, { timeoutMs: options.timeoutMs })
  const control = options.control ?? new RuntimeSettingsControl({
    baseUrl: descriptor.controlUrl ?? descriptor.workspaceUrl,
    token: descriptor.token,
  })
  const settings = createRuntimeRemoteSettingsFacades(control)
  const controller = new RemoteWorkbenchController(client)
  const flows = new ClientFlowRuntime(client)
  flows.start()
  const browserIntegrations = createClientBrowserIntegrationService(client)
  const sleepPrevention = createClientSleepPreventionService(client)

  return {
    client,
    controller,
    flows,
    remoteAccess: settings.remoteAccess,
    tailnetServe: settings.tailnetServe,
    browserIntegrations,
    sleepPrevention,
    browsers: options.browsers,
    terminals: options.terminals,
    updates: options.updates,
    pluginHost: options.pluginHost,
    settings,
    dispose: async () => {
      flows.dispose()
      await controller.dispose()
      settings.dispose()
      client.disconnect()
    },
  }
}

export interface ShellWorkbenchControllerOptions {
  sessions?: readonly PiSessionSummary[] | undefined
}

/** Placeholder controller so the native shell can render before a runtime is attached. */
export class ShellWorkbenchController implements WorkbenchControllerSurface {
  readonly presence = new PresenceRegistry()
  readonly #listeners = new Set<() => void>()
  #inner: WorkbenchControllerSurface | undefined
  #unsubInner: (() => void) | undefined
  #snapshot: WorkbenchState
  #receiptClearListeners = new Set<(sessionPath: string) => void>()
  #pendingSession: PiSessionSummary | undefined
  #pendingEditorText: string | undefined

  constructor(workspacePath: string, options: ShellWorkbenchControllerOptions = {}) {
    this.#snapshot = {
      ...createInitialState(workspacePath),
      connection: 'connecting',
      connectionMessage: 'Connecting…',
      activity: 'Connecting',
      sessions: options.sessions ? [...options.sessions] : [],
    }
  }

  adopt(controller: WorkbenchControllerSurface): void {
    this.#unsubInner?.()
    this.#inner = controller
    this.#unsubInner = controller.subscribe(() => {
      this.#snapshot = controller.getSnapshot()
      this.#emit()
    })
    const pendingSession = this.#pendingSession
    const pendingEditorText = this.#pendingEditorText ?? (this.#snapshot.editorText || undefined)
    this.#pendingSession = undefined
    this.#pendingEditorText = undefined
    this.#snapshot = controller.getSnapshot()
    this.#emit()
    if (pendingEditorText) controller.setEditorText(pendingEditorText)
    if (pendingSession) void controller.switchSession(pendingSession)
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): WorkbenchState => this.#inner?.getSnapshot() ?? this.#snapshot

  #emit(): void { for (const listener of this.#listeners) listener() }

  #patch(partial: Partial<WorkbenchState>): void {
    if (this.#inner) return
    this.#snapshot = { ...this.#snapshot, ...partial }
    this.#emit()
  }

  async loadEarlierMessages(): Promise<void> { await this.#inner?.loadEarlierMessages() }
  async getTranscriptDetail(entryId: string, options: { offset?: number; limit?: number } = {}) {
    if (!this.#inner) throw new Error('Not connected')
    return this.#inner.getTranscriptDetail(entryId, options)
  }
  acceptAgentEvent(event: RpcRecord): void { this.#inner?.acceptAgentEvent(event) }
  acceptAgentStatus(status: TransportStatus): void { this.#inner?.acceptAgentStatus(status) }
  notify(kind: NoticeKind, message: string, options?: NoticeOptions): void {
    if (this.#inner) this.#inner.notify(kind, message, options)
  }
  async start(): Promise<void> { await this.#inner?.start() }
  async reconnect(): Promise<void> { await this.#inner?.reconnect() }
  async submit(text: string, options: { queue?: boolean } = {}): Promise<void> {
    if (this.#inner) return this.#inner.submit(text, options)
  }
  queueInput(text: string, images: readonly ComposerImage[] = [], options: { paused?: boolean; lane?: QueueLane } = {}): QueuedInput | undefined {
    return this.#inner?.queueInput(text, images, options)
  }
  enqueueQueueInputs(inputs: readonly QueueInputDraft[], options: { start?: boolean; paused?: boolean } = {}): QueuedInput[] {
    return this.#inner?.enqueueQueueInputs(inputs, options) ?? []
  }
  hasQueuedFlow(runId: string): boolean { return this.#inner?.hasQueuedFlow(runId) ?? false }
  removeQueuedFlow(runId: string): void { this.#inner?.removeQueuedFlow(runId) }
  updateQueuedInput(id: string, text: string): void { this.#inner?.updateQueuedInput(id, text) }
  removeQueuedInput(id: string): void { this.#inner?.removeQueuedInput(id) }
  moveQueuedInput(id: string, targetIndex: number): void { this.#inner?.moveQueuedInput(id, targetIndex) }
  moveQueuedInputToLane(id: string, lane: QueueLane): void { this.#inner?.moveQueuedInputToLane(id, lane) }
  toggleQueuedInputPause(id: string): void { this.#inner?.toggleQueuedInputPause(id) }
  async queueFabricPeerGate(): Promise<void> { await this.#inner?.queueFabricPeerGate() }
  cancelBlockingQueueActivity(): void { this.#inner?.cancelBlockingQueueActivity() }
  async steerQueuedInput(id: string): Promise<void> { await this.#inner?.steerQueuedInput(id) }
  resumeQueue(): void { this.#inner?.resumeQueue() }
  async drainQueueMessages(): Promise<void> { await this.#inner?.drainQueueMessages() }
  async pause(): Promise<void> { await this.#inner?.pause() }
  async abort(): Promise<void> { await this.#inner?.abort() }
  async newSession(): Promise<void> { await this.#inner?.newSession() }
  async switchWorkspace(workspacePath: string): Promise<void> { await this.#inner?.switchWorkspace(workspacePath) }
  async switchSession(session: PiSessionSummary): Promise<void> {
    if (this.#inner) return this.#inner.switchSession(session)
    this.#pendingSession = session
    this.#patch({
      ...(session.cwd ? { workspacePath: session.cwd } : {}),
      session: { ...this.#snapshot.session, sessionId: session.id, sessionFile: session.path, sessionName: session.title, isStreaming: false },
      connection: 'connecting',
      connectionMessage: 'Opening thread',
      activity: 'Opening thread',
    })
  }
  async refreshSessions(): Promise<void> { await this.#inner?.refreshSessions() }
  async loadMoreSessions(): Promise<void> { await this.#inner?.loadMoreSessions() }
  async openSessionTree(options?: { preserveQueue?: boolean }): Promise<void> { await this.#inner?.openSessionTree(options) }
  async navigateTree(entryId: string, options?: NavigateTreeOptions): Promise<void> { await this.#inner?.navigateTree(entryId, options) }
  async cloneSession(): Promise<void> { await this.#inner?.cloneSession() }
  async forkFrom(entryId: string, options: { preserveQueue?: boolean } = {}): Promise<void> { await this.#inner?.forkFrom(entryId, options) }
  async exportSession(): Promise<string | undefined> { return this.#inner ? this.#inner.exportSession() : undefined }
  async setModel(model: PiModel): Promise<void> { await this.#inner?.setModel(model) }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> { await this.#inner?.setThinkingLevel(level) }
  async compact(): Promise<void> { await this.#inner?.compact() }
  completeUiRequest(id: number): void { this.#inner?.completeUiRequest(id) }
  setEditorText(text: string): void {
    if (this.#inner) {
      this.#inner.setEditorText(text)
      return
    }
    this.#pendingEditorText = text
    this.#patch({ editorText: text })
  }
  addEditorImage(image: ComposerImage): void { this.#inner?.addEditorImage(image) }
  removeEditorImage(id: string): void { this.#inner?.removeEditorImage(id) }
  dismissNotice(id: number): void { this.#inner?.dismissNotice(id) }
  markNoticeRead(id: number): void { this.#inner?.markNoticeRead(id) }
  markNoticesRead(): void { this.#inner?.markNoticesRead() }
  async activateNotice(id: number): Promise<void> { await this.#inner?.activateNotice(id) }
  clearNotices(): void { this.#inner?.clearNotices() }
  setReceipts(receipts: MutationReceipt[]): void {
    if (this.#inner) this.#inner.setReceipts(receipts)
    else this.#patch({ receipts })
  }
  onClearReceipts(listener: (sessionPath: string) => void): () => void {
    if (this.#inner) return this.#inner.onClearReceipts(listener)
    this.#receiptClearListeners.add(listener)
    return () => { this.#receiptClearListeners.delete(listener) }
  }
  clearReceipts(sessionPath: string): void {
    if (this.#inner) {
      this.#inner.clearReceipts(sessionPath)
      return
    }
    for (const listener of this.#receiptClearListeners) listener(sessionPath)
  }
  settleThread(path: string): void { this.#inner?.settleThread(path) }
  snoozeThread(path: string, snoozedUntil: number): void { this.#inner?.snoozeThread(path, snoozedUntil) }
  wakeThread(path: string): void { this.#inner?.wakeThread(path) }
  pinThread(path: string): void { this.#inner?.pinThread(path) }
  unpinThread(path: string): void { this.#inner?.unpinThread(path) }
  async renameThread(name: string): Promise<void> { await this.#inner?.renameThread(name) }
  async regenerateThreadTitle(path: string): Promise<void> { await this.#inner?.regenerateThreadTitle(path) }
  setThreadTitleSettings(settings: Partial<ThreadTitleSettings>): void { this.#inner?.setThreadTitleSettings(settings) }
  setThreadPriority(path: string, priority: ThreadPriority | undefined): void { this.#inner?.setThreadPriority(path, priority) }
  setThreadLabels(path: string, labels: readonly string[]): void { this.#inner?.setThreadLabels(path, labels) }
  markThreadRead(path: string, updatedAt: number): void { this.#inner?.markThreadRead(path, updatedAt) }
  markThreadsRead(threads: readonly { path: string; updatedAt: number }[]): void { this.#inner?.markThreadsRead(threads) }
  async refreshWorkspaceDiff(): Promise<void> { await this.#inner?.refreshWorkspaceDiff() }
  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void { this.#inner?.respondToDialog(response) }
  submitAskUserQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[], note?: string): void {
    this.#inner?.submitAskUserQuestionnaire(toolCallId, answers, note)
  }
  cancelAskUserQuestionnaire(toolCallId: string): void { this.#inner?.cancelAskUserQuestionnaire(toolCallId) }
  setAskUserQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void {
    this.#inner?.setAskUserQuestionnaireCollapsed(toolCallId, collapsed)
  }
  async dispose(): Promise<void> {
    this.#unsubInner?.()
    this.#unsubInner = undefined
    this.#inner = undefined
    this.#listeners.clear()
  }
}

export function createShellWorkbenchController(workspacePath: string, options?: ShellWorkbenchControllerOptions): ShellWorkbenchController {
  return new ShellWorkbenchController(workspacePath, options)
}


