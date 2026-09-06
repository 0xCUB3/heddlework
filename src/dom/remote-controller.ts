// A WorkbenchController stand-in for browsers. State comes from the host's snapshot stream; every mutation becomes a
// protocol command. src/ui receives it typed as WorkbenchController, so the method names and shapes mirror that class.

import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState, ThreadPriority } from '../workbench/state.ts'
import type { WorkbenchSnapshot, WorkbenchCommand } from '../protocol/index.ts'
import type { ComposerImage, PiModel, ThinkingLevel } from '../pi/types.ts'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { NoticeKind } from '../workbench/notices.ts'
import type { QueueLane } from '../workbench/queue.ts'
import { PresenceRegistry } from '../workbench/presence.ts'
import type { WorkspaceClient } from '../web/client.ts'

const EMPTY_IMAGE_DATA = ''

// Editor text is echoed locally so typing never waits for a host round trip; the host copy is the source of truth only
// when it changes for another reason (submit clears it, another client edits it).
export class RemoteWorkbenchController {
  readonly presence = new PresenceRegistry()
  readonly #client: WorkspaceClient
  readonly #listeners = new Set<() => void>()
  #snapshot: WorkbenchState
  #hostSnapshot: WorkbenchSnapshot | undefined
  #localEditorText: string | undefined
  #editorTimer: ReturnType<typeof setTimeout> | undefined
  #unsubscribe: () => void

  constructor(client: WorkspaceClient) {
    this.#client = client
    this.#snapshot = this.#materialize(client.getSnapshot().state)
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

  #pull(): void {
    const next = this.#client.getSnapshot().state
    if (next === this.#hostSnapshot) return
    const previousHost = this.#hostSnapshot
    this.#hostSnapshot = next
    if (previousHost && next && previousHost.editorText !== next.editorText && next.editorText !== this.#localEditorText) this.#localEditorText = undefined
    this.#snapshot = this.#materialize(next)
    this.#emit()
  }

  #materialize(snapshot: WorkbenchSnapshot | undefined): WorkbenchState {
    const base = (snapshot ?? this.#hostSnapshot) as WorkbenchSnapshot | undefined
    if (!base) return this.#snapshot ?? ({} as WorkbenchState)
    const editorImages = base.editorImages.map((image) => ({ ...image, data: typeof image.data === 'string' ? image.data : EMPTY_IMAGE_DATA })) as ComposerImage[]
    return { ...base, editorImages, ...(this.#localEditorText !== undefined ? { editorText: this.#localEditorText } : {}) } as WorkbenchState
  }

  #emit(): void { for (const listener of this.#listeners) listener() }

  #send(command: WorkbenchCommand): Promise<void> {
    return this.#client.sendAndReport(command)
  }

  notify(kind: NoticeKind, message: string): void { void this.#send({ type: 'notify', kind, message }) }
  async start(): Promise<void> {}
  async reconnect(): Promise<void> { this.#client.reconnect() }
  async submit(text: string, options: { queue?: boolean } = {}): Promise<void> {
    this.#localEditorText = undefined
    await this.#send({ type: 'submit', text, ...(options.queue ? { queue: true } : {}) })
  }
  queueInput(text: string, _images: readonly ComposerImage[] = [], options: { paused?: boolean; lane?: QueueLane } = {}): undefined {
    void this.#send({ type: 'queueInput', text, ...(options.lane ? { lane: options.lane } : {}), ...(options.paused !== undefined ? { paused: options.paused } : {}) })
    return undefined
  }
  enqueueQueueInputs(): never[] { return [] }
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
  async newSession(): Promise<void> { await this.#send({ type: 'newSession' }) }
  async switchWorkspace(workspacePath: string): Promise<void> { await this.#send({ type: 'switchWorkspace', path: workspacePath }) }
  async switchSession(session: PiSessionSummary): Promise<void> { await this.#send({ type: 'switchSession', path: session.path }) }
  async refreshSessions(): Promise<void> { await this.#send({ type: 'refreshSessions' }) }
  async loadMoreSessions(): Promise<void> { await this.#send({ type: 'loadMoreSessions' }) }
  async openSessionTree(): Promise<void> {}
  async navigateTree(entryId: string): Promise<void> { await this.#send({ type: 'navigateTree', entryId }) }
  async cloneSession(): Promise<void> { await this.#send({ type: 'cloneSession' }) }
  async forkFrom(entryId: string): Promise<void> { await this.#send({ type: 'navigateTree', entryId }) }
  async exportSession(): Promise<string | undefined> { await this.#send({ type: 'exportSession' }); return undefined }
  async setModel(model: PiModel): Promise<void> { await this.#send({ type: 'setModel', provider: model.provider, id: model.id }) }
  async setThinkingLevel(level: ThinkingLevel): Promise<void> { await this.#send({ type: 'setThinkingLevel', level }) }
  async compact(): Promise<void> { await this.#send({ type: 'compact' }) }
  completeUiRequest(id: number): void { void this.#send({ type: 'completeUiRequest', id }) }
  setEditorText(text: string): void {
    this.#localEditorText = text
    this.#snapshot = { ...this.#snapshot, editorText: text }
    this.#emit()
    if (this.#editorTimer) clearTimeout(this.#editorTimer)
    this.#editorTimer = setTimeout(() => { void this.#send({ type: 'setEditorText', text }) }, 250)
  }
  addEditorImage(image: ComposerImage): void { void this.#send({ type: 'addEditorImage', image }) }
  removeEditorImage(id: string): void { void this.#send({ type: 'removeEditorImage', id }) }
  dismissNotice(id: number): void { void this.#send({ type: 'dismissNotice', id }) }
  markNoticeRead(id: number): void { void this.#send({ type: 'markNoticeRead', id }) }
  markNoticesRead(): void { void this.#send({ type: 'markNoticesRead' }) }
  async activateNotice(id: number): Promise<void> { await this.#send({ type: 'activateNotice', id }) }
  clearNotices(): void { void this.#send({ type: 'clearNotices' }) }
  setReceipts(): void {}
  onClearReceipts(): () => void { return () => undefined }
  clearReceipts(sessionPath: string): void { void this.#send({ type: 'clearReceipts', sessionPath }) }
  settleThread(path: string): void { void this.#send({ type: 'settleThread', path }) }
  snoozeThread(path: string, snoozedUntil: number): void { void this.#send({ type: 'snoozeThread', path, snoozedUntil }) }
  wakeThread(path: string): void { void this.#send({ type: 'wakeThread', path }) }
  setThreadPriority(path: string, priority: ThreadPriority | undefined): void { void this.#send({ type: 'setThreadPriority', path, priority }) }
  setThreadLabels(path: string, labels: readonly string[]): void { void this.#send({ type: 'setThreadLabels', path, labels: [...labels] }) }
  markThreadRead(path: string, updatedAt: number): void { void this.#send({ type: 'markThreadRead', path, updatedAt }) }
  markThreadsRead(threads: readonly { path: string; updatedAt: number }[]): void { void this.#send({ type: 'markThreadsRead', threads: [...threads] }) }
  async refreshWorkspaceDiff(): Promise<void> { await this.#send({ type: 'refreshWorkspaceDiff' }) }
  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void { void this.#send({ type: 'respondToDialog', ...response }) }
  submitAskUserQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[]): void { void this.#send({ type: 'submitAskUserQuestionnaire', toolCallId, answers: [...answers] }) }
  cancelAskUserQuestionnaire(toolCallId: string): void { void this.#send({ type: 'cancelAskUserQuestionnaire', toolCallId }) }
  setAskUserQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void { void this.#send({ type: 'setAskUserQuestionnaireCollapsed', toolCallId, collapsed }) }
  async dispose(): Promise<void> { this.#unsubscribe(); this.#listeners.clear() }
}

export function asWorkbenchController(remote: RemoteWorkbenchController): WorkbenchController {
  return remote as unknown as WorkbenchController
}
