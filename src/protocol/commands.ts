import type { ComposerImage, ThinkingLevel } from '../pi/types.ts'
import type { AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { QueueLane } from '../workbench/queue.ts'
import type { ThreadPriority } from '../workbench/state.ts'

// Every command a remote surface may issue. Each member maps onto one public WorkbenchController method.
export type WorkbenchCommand =
  | { type: 'submit'; text: string; queue?: boolean }
  | { type: 'queueInput'; text: string; lane?: QueueLane; paused?: boolean }
  | { type: 'updateQueuedInput'; id: string; text: string }
  | { type: 'removeQueuedInput'; id: string }
  | { type: 'moveQueuedInput'; id: string; targetIndex: number }
  | { type: 'moveQueuedInputToLane'; id: string; lane: QueueLane }
  | { type: 'toggleQueuedInputPause'; id: string }
  | { type: 'steerQueuedInput'; id: string }
  | { type: 'resumeQueue' }
  | { type: 'pause' }
  | { type: 'abort' }
  | { type: 'newSession' }
  | { type: 'switchSession'; path: string }
  | { type: 'refreshSessions' }
  | { type: 'loadMoreSessions' }
  | { type: 'loadEarlierMessages' }
  | { type: 'setModel'; provider: string; id: string }
  | { type: 'setThinkingLevel'; level: ThinkingLevel }
  | { type: 'compact' }
  | { type: 'respondToDialog'; value?: string; confirmed?: boolean; cancelled?: boolean }
  | { type: 'submitAskUserQuestionnaire'; toolCallId: string; answers: AskUserSubmissionAnswer[] }
  | { type: 'cancelAskUserQuestionnaire'; toolCallId: string }
  | { type: 'settleThread'; path: string }
  | { type: 'snoozeThread'; path: string; snoozedUntil: number }
  | { type: 'wakeThread'; path: string }
  | { type: 'setThreadPriority'; path: string; priority: ThreadPriority | undefined }
  | { type: 'setThreadLabels'; path: string; labels: string[] }
  | { type: 'markThreadRead'; path: string; updatedAt: number }
  | { type: 'refreshWorkspaceDiff' }
  | { type: 'dismissNotice'; id: number }
  | { type: 'clearNotices' }
  | { type: 'setEditorText'; text: string }
  | { type: 'addEditorImage'; image: ComposerImage }
  | { type: 'removeEditorImage'; id: string }
  | { type: 'clearReceipts'; sessionPath: string }

export type WorkbenchCommandType = WorkbenchCommand['type']

export const WORKBENCH_COMMAND_TYPES: readonly WorkbenchCommandType[] = [
  'submit', 'queueInput', 'updateQueuedInput', 'removeQueuedInput', 'moveQueuedInput', 'moveQueuedInputToLane',
  'toggleQueuedInputPause', 'steerQueuedInput', 'resumeQueue', 'pause', 'abort', 'newSession', 'switchSession',
  'refreshSessions', 'loadMoreSessions', 'loadEarlierMessages', 'setModel', 'setThinkingLevel', 'compact',
  'respondToDialog', 'submitAskUserQuestionnaire', 'cancelAskUserQuestionnaire', 'settleThread', 'snoozeThread',
  'wakeThread', 'setThreadPriority', 'setThreadLabels', 'markThreadRead', 'refreshWorkspaceDiff', 'dismissNotice',
  'clearNotices', 'setEditorText', 'addEditorImage', 'removeEditorImage', 'clearReceipts',
]

export function isWorkbenchCommand(value: unknown): value is WorkbenchCommand {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && (WORKBENCH_COMMAND_TYPES as readonly string[]).includes(type)
}

export async function applyWorkbenchCommand(controller: WorkbenchController, command: WorkbenchCommand): Promise<void> {
  switch (command.type) {
    case 'submit':
      await controller.submit(command.text, command.queue ? { queue: true } : {})
      return
    case 'queueInput':
      controller.queueInput(command.text, [], {
        ...(command.lane ? { lane: command.lane } : {}),
        ...(command.paused !== undefined ? { paused: command.paused } : {}),
      })
      return
    case 'updateQueuedInput':
      controller.updateQueuedInput(command.id, command.text)
      return
    case 'removeQueuedInput':
      controller.removeQueuedInput(command.id)
      return
    case 'moveQueuedInput':
      controller.moveQueuedInput(command.id, command.targetIndex)
      return
    case 'moveQueuedInputToLane':
      controller.moveQueuedInputToLane(command.id, command.lane)
      return
    case 'toggleQueuedInputPause':
      controller.toggleQueuedInputPause(command.id)
      return
    case 'steerQueuedInput':
      await controller.steerQueuedInput(command.id)
      return
    case 'resumeQueue':
      controller.resumeQueue()
      return
    case 'pause':
      await controller.pause()
      return
    case 'abort':
      await controller.abort()
      return
    case 'newSession':
      await controller.newSession()
      return
    case 'switchSession': {
      const session = controller.getSnapshot().sessions.find((entry) => entry.path === command.path)
      if (!session) throw new Error(`Unknown session: ${command.path}`)
      await controller.switchSession(session)
      return
    }
    case 'refreshSessions':
      await controller.refreshSessions()
      return
    case 'loadMoreSessions':
      await controller.loadMoreSessions()
      return
    case 'loadEarlierMessages':
      await controller.loadEarlierMessages()
      return
    case 'setModel': {
      const model = controller.getSnapshot().models.find((entry) => entry.provider === command.provider && entry.id === command.id)
      if (!model) throw new Error(`Unknown model: ${command.provider}/${command.id}`)
      await controller.setModel(model)
      return
    }
    case 'setThinkingLevel':
      await controller.setThinkingLevel(command.level)
      return
    case 'compact':
      await controller.compact()
      return
    case 'respondToDialog':
      controller.respondToDialog({
        ...(command.value !== undefined ? { value: command.value } : {}),
        ...(command.confirmed !== undefined ? { confirmed: command.confirmed } : {}),
        ...(command.cancelled !== undefined ? { cancelled: command.cancelled } : {}),
      })
      return
    case 'submitAskUserQuestionnaire':
      controller.submitAskUserQuestionnaire(command.toolCallId, command.answers)
      return
    case 'cancelAskUserQuestionnaire':
      controller.cancelAskUserQuestionnaire(command.toolCallId)
      return
    case 'settleThread':
      controller.settleThread(command.path)
      return
    case 'snoozeThread':
      controller.snoozeThread(command.path, command.snoozedUntil)
      return
    case 'wakeThread':
      controller.wakeThread(command.path)
      return
    case 'setThreadPriority':
      controller.setThreadPriority(command.path, command.priority)
      return
    case 'setThreadLabels':
      controller.setThreadLabels(command.path, command.labels)
      return
    case 'markThreadRead':
      controller.markThreadRead(command.path, command.updatedAt)
      return
    case 'refreshWorkspaceDiff':
      await controller.refreshWorkspaceDiff()
      return
    case 'dismissNotice':
      controller.dismissNotice(command.id)
      return
    case 'clearNotices':
      controller.clearNotices()
      return
    case 'setEditorText':
      controller.setEditorText(command.text)
      return
    case 'addEditorImage':
      controller.addEditorImage(command.image)
      return
    case 'clearReceipts':
      controller.clearReceipts(command.sessionPath)
      return
    case 'removeEditorImage':
      controller.removeEditorImage(command.id)
      return
    default: {
      const unreachable: never = command
      throw new Error(`Unsupported workbench command: ${String((unreachable as { type?: unknown }).type)}`)
    }
  }
}
