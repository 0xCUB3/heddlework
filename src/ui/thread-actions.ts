export type ThreadActionId =
  | 'pin'
  | 'unpin'
  | 'rename'
  | 'regenerate-title'
  | 'copy-path'
  | 'copy-thread-id'
  | 'clone'
  | 'export'
  | 'settle'
  | 'unsettle'
  | 'snooze'
  | 'wake'

export interface ThreadAction {
  id: ThreadActionId
  label: string
  detail?: string
  disabled?: boolean
  danger?: boolean
  testId?: string
}

export interface ThreadActionState {
  isPinned: boolean
  isSettled: boolean
  isSnoozed: boolean
  isRunning: boolean
  hasMessages: boolean
}

export function buildThreadActions(state: ThreadActionState): ThreadAction[] {
  const pinned = state.isPinned && !state.isSettled
  const running = state.isRunning ? 'Wait until the run finishes' : undefined
  const missing = !state.hasMessages
  return [
    pinned
      ? { id: 'unpin', label: 'Unpin thread', detail: 'Return it to recency order' }
      : { id: 'pin', label: 'Pin thread', detail: 'Keep it at the top of Active' },
    {
      id: 'rename',
      label: 'Rename thread',
      detail: running ?? 'Change the session name',
      ...(running ? { disabled: true } : {}),
    },
    {
      id: 'regenerate-title',
      label: 'Regenerate title',
      detail: 'Ask the title model for a new name',
    },
    { id: 'copy-path', label: 'Copy path', detail: 'Copy the session file path' },
    { id: 'copy-thread-id', label: 'Copy thread id', detail: 'Copy the Pi session id' },
    {
      id: 'clone',
      label: 'Clone thread',
      detail: running ?? (missing ? 'Nothing to clone yet' : 'Duplicate the current Pi branch'),
      ...(running || missing ? { disabled: true } : {}),
    },
    {
      id: 'export',
      label: 'Export transcript',
      detail: running ?? (missing ? 'Nothing to export yet' : 'Write this thread as HTML'),
      ...(running || missing ? { disabled: true } : {}),
    },
    state.isSettled
      ? { id: 'unsettle', label: 'Return to Active', detail: 'Move it back to Active' }
      : {
          id: 'settle',
          label: 'Settle thread',
          detail: running ?? 'Move it to Settled',
          ...(running ? { disabled: true } : {}),
        },
    state.isSnoozed
      ? { id: 'wake', label: 'Wake thread', detail: 'Clear the snooze' }
      : { id: 'snooze', label: 'Snooze thread', detail: 'Hide it until later' },
  ]
}
