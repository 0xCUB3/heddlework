import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { ComposerImage, PiModel, RpcRecord, ThinkingLevel } from '../pi/types.ts'
import type { AgentTransport, TransportStatus } from '../pi/transport.ts'
import type { AskUserSubmissionAnswer } from './ask-user.ts'
import type { NoticeKind, NoticeOptions, ThreadPriority, WorkbenchState } from './state.ts'
import type { ThreadTitleSettings } from './thread-titles.ts'
import type { QueuedInput, QueueInputDraft, QueueLane } from './queue.ts'
import type { MutationReceipt } from '../receipts/types.ts'
import type { PresenceRegistry } from './presence.ts'
import type { NavigateTreeOptions } from './controller.ts'
import type { TranscriptDetail } from '../protocol/transcript.ts'

/** Structural contract for GPUix, DOM, and native attach clients. No optional no-op stubs. */
export interface WorkbenchControllerSurface {
  readonly presence: PresenceRegistry
  subscribe(listener: () => void): () => void
  getSnapshot(): WorkbenchState
  loadEarlierMessages(): Promise<void>
  getTranscriptDetail(entryId: string, options?: { offset?: number; limit?: number }): Promise<TranscriptDetail>
  acceptAgentEvent(event: RpcRecord): void
  acceptAgentStatus(status: TransportStatus): void
  notify(kind: NoticeKind, message: string, options?: NoticeOptions): void
  start(): Promise<void>
  reconnect(): Promise<void>
  submit(text: string, options?: { queue?: boolean }): Promise<void>
  queueInput(text: string, images?: readonly ComposerImage[], options?: { paused?: boolean; lane?: QueueLane }): QueuedInput | undefined
  enqueueQueueInputs(inputs: readonly QueueInputDraft[], options?: { start?: boolean; paused?: boolean }): QueuedInput[]
  hasQueuedFlow(runId: string): boolean
  removeQueuedFlow(runId: string): void
  updateQueuedInput(id: string, text: string): void
  removeQueuedInput(id: string): void
  moveQueuedInput(id: string, targetIndex: number): void
  moveQueuedInputToLane(id: string, lane: QueueLane): void
  toggleQueuedInputPause(id: string): void
  queueFabricPeerGate(): Promise<void>
  cancelBlockingQueueActivity(): void
  steerQueuedInput(id: string): Promise<void>
  resumeQueue(): void
  drainQueueMessages(): Promise<void>
  pause(): Promise<void>
  abort(): Promise<void>
  newSession(): Promise<void>
  switchWorkspace(workspacePath: string): Promise<void>
  switchSession(session: PiSessionSummary): Promise<void>
  refreshSessions(): Promise<void>
  loadMoreSessions(): Promise<void>
  openSessionTree(options?: { preserveQueue?: boolean }): Promise<void>
  navigateTree(entryId: string, options?: NavigateTreeOptions): Promise<void>
  cloneSession(): Promise<void>
  forkFrom(entryId: string, options?: { preserveQueue?: boolean }): Promise<void>
  exportSession(): Promise<string | undefined>
  setModel(model: PiModel): Promise<void>
  setThinkingLevel(level: ThinkingLevel): Promise<void>
  compact(): Promise<void>
  completeUiRequest(id: number): void
  setEditorText(text: string): void
  addEditorImage(image: ComposerImage): void
  removeEditorImage(id: string): void
  dismissNotice(id: number): void
  markNoticeRead(id: number): void
  markNoticesRead(): void
  activateNotice(id: number): Promise<void>
  clearNotices(): void
  setReceipts(receipts: MutationReceipt[]): void
  onClearReceipts(listener: (sessionPath: string) => void): () => void
  clearReceipts(sessionPath: string): void
  settleThread(path: string): void
  snoozeThread(path: string, snoozedUntil: number): void
  wakeThread(path: string): void
  pinThread(path: string): void
  unpinThread(path: string): void
  renameThread(name: string): Promise<void>
  // Asks the title model for a fresh name based on the whole thread; a no-op when generation is unavailable.
  regenerateThreadTitle(path: string): Promise<void>
  setThreadTitleSettings(settings: Partial<ThreadTitleSettings>): void
  setThreadPriority(path: string, priority: ThreadPriority | undefined): void
  setThreadLabels(path: string, labels: readonly string[]): void
  markThreadRead(path: string, updatedAt: number): void
  markThreadsRead(threads: readonly { path: string; updatedAt: number }[]): void
  refreshWorkspaceDiff(): Promise<void>
  respondToDialog(response: { value?: string; confirmed?: boolean; cancelled?: boolean }): void
  submitAskUserQuestionnaire(toolCallId: string, answers: readonly AskUserSubmissionAnswer[], note?: string): void
  cancelAskUserQuestionnaire(toolCallId: string): void
  setAskUserQuestionnaireCollapsed(toolCallId: string, collapsed: boolean): void
  dispose(): Promise<void>
}

