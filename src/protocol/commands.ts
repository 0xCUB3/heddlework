import { BROWSER_INTEGRATION_COMMAND_TYPES, isBrowserIntegrationCommand, type BrowserIntegrationCommand } from '../browser/integration-types.ts'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import type { FlowRuntime } from '../flows/runtime.ts'
import { isSleepPreventionWhen, parseSleepPreventionPolicy, type SleepPreventionPolicy } from '../power/types.ts'
import type { ComposerImage, ThinkingLevel } from '../pi/types.ts'
import type { AskUserSubmissionAnswer } from '../workbench/ask-user.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import { isPresenceSurface, isPresenceVisibility, type PresenceSurface, type PresenceVisibility } from '../workbench/presence.ts'
import type { QueueLane } from '../workbench/queue.ts'
import type { ThreadPriority } from '../workbench/state.ts'
import { applyTerminalCommand, isTerminalCommand, TERMINAL_COMMAND_TYPES, type TerminalCommand, type TerminalCommandTarget } from './terminal.ts'

export type SleepPreventionCommand = { type: 'setSleepPreventionPolicy'; when: SleepPreventionPolicy['when']; keepDisplayAwake: boolean }

export const SLEEP_PREVENTION_COMMAND_TYPES = ['setSleepPreventionPolicy'] as const

export function isSleepPreventionCommand(value: unknown): value is SleepPreventionCommand {
  if (!value || typeof value !== 'object') return false
  const command = value as { type?: unknown; when?: unknown; keepDisplayAwake?: unknown }
  return command.type === 'setSleepPreventionPolicy' && isSleepPreventionWhen(command.when) && typeof command.keepDisplayAwake === 'boolean'
}

// Every command a remote surface may issue. Each member maps onto one public WorkbenchController method.
export type WorkbenchCommand =
  | BrowserIntegrationCommand
  | TerminalCommand
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
  | { type: 'markNoticeRead'; id: number }
  | { type: 'markNoticesRead' }
  | { type: 'activateNotice'; id: number }
  | { type: 'clearNotices' }
  | { type: 'reportPresence'; clientId: string; surface: PresenceSurface; visibility: PresenceVisibility; sessionPath?: string }
  | { type: 'setEditorText'; text: string }
  | { type: 'addEditorImage'; image: ComposerImage }
  | { type: 'removeEditorImage'; id: string }
  | { type: 'clearReceipts'; sessionPath: string }
  | { type: 'mergeLane'; laneId: string }
  | { type: 'removeLane'; laneId: string }
  | SleepPreventionCommand

export type WorkbenchCommandType = WorkbenchCommand['type']

export const WORKBENCH_COMMAND_TYPES: readonly WorkbenchCommandType[] = [
  ...BROWSER_INTEGRATION_COMMAND_TYPES,
  ...SLEEP_PREVENTION_COMMAND_TYPES,
  ...TERMINAL_COMMAND_TYPES,
  'submit', 'queueInput', 'updateQueuedInput', 'removeQueuedInput', 'moveQueuedInput', 'moveQueuedInputToLane',
  'toggleQueuedInputPause', 'steerQueuedInput', 'resumeQueue', 'pause', 'abort', 'newSession', 'switchSession',
  'refreshSessions', 'loadMoreSessions', 'loadEarlierMessages', 'setModel', 'setThinkingLevel', 'compact',
  'respondToDialog', 'submitAskUserQuestionnaire', 'cancelAskUserQuestionnaire', 'settleThread', 'snoozeThread',
  'wakeThread', 'setThreadPriority', 'setThreadLabels', 'markThreadRead', 'refreshWorkspaceDiff', 'dismissNotice',
  'markNoticeRead', 'markNoticesRead', 'activateNotice', 'clearNotices', 'reportPresence', 'setEditorText', 'addEditorImage', 'removeEditorImage', 'clearReceipts', 'mergeLane', 'removeLane',
]

export function isWorkbenchCommand(value: unknown): value is WorkbenchCommand {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  if (typeof type === 'string' && (BROWSER_INTEGRATION_COMMAND_TYPES as readonly string[]).includes(type)) return isBrowserIntegrationCommand(value)
  if (typeof type === 'string' && (SLEEP_PREVENTION_COMMAND_TYPES as readonly string[]).includes(type)) return isSleepPreventionCommand(value)
  if (typeof type === 'string' && (TERMINAL_COMMAND_TYPES as readonly string[]).includes(type)) return isTerminalCommand(value)
  return typeof type === 'string' && (WORKBENCH_COMMAND_TYPES as readonly string[]).includes(type)
}

export interface WorkbenchCommandTargets {
  browserIntegrations?: BrowserIntegrationService | undefined
  flows?: Pick<FlowRuntime, 'mergeLane' | 'removeLane'> | undefined
  sleepPrevention?: { setPolicy(policy: SleepPreventionPolicy): void } | undefined
  terminals?: TerminalCommandTarget | undefined
}

export async function applyWorkbenchCommand(controller: WorkbenchController, command: WorkbenchCommand, targets: WorkbenchCommandTargets = {}): Promise<void> {
  switch (command.type) {
    case 'selectBrowserIntegration': case 'requestBrowserTask': case 'approveBrowserTask': case 'cancelBrowserTask': case 'clearBrowserTask':
      if (!targets.browserIntegrations) throw new Error('Browser integrations unavailable on this host')
      targets.browserIntegrations.dispatch(command)
      return
    case 'setSleepPreventionPolicy':
      if (!targets.sleepPrevention) throw new Error('Sleep prevention is unavailable on this host')
      targets.sleepPrevention.setPolicy(parseSleepPreventionPolicy(command))
      return
    case 'openTerminal': case 'writeTerminal': case 'resizeTerminal': case 'closeTerminal':
      if (!targets.terminals) throw new Error('Terminal is unavailable on this host')
      await applyTerminalCommand(targets.terminals, command)
      return
    case 'mergeLane': {
      if (!targets.flows) throw new Error('Flow runtime is not available')
      const result = await targets.flows.mergeLane(command.laneId)
      if (!result.merged) throw new Error(result.message)
      return
    }
    case 'removeLane':
      if (!targets.flows) throw new Error('Flow runtime is not available')
      await targets.flows.removeLane(command.laneId)
      return
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
    case 'markNoticeRead':
      controller.markNoticeRead(command.id)
      return
    case 'markNoticesRead':
      controller.markNoticesRead()
      return
    case 'activateNotice':
      await controller.activateNotice(command.id)
      return
    case 'reportPresence':
      if (!command.clientId || !isPresenceSurface(command.surface) || !isPresenceVisibility(command.visibility)) return
      controller.presence.upsert({
        clientId: command.clientId,
        surface: command.surface,
        visibility: command.visibility,
        ...(command.sessionPath ? { sessionPath: command.sessionPath } : {}),
      })
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
