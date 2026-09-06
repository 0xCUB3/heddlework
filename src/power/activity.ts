const RUNNING_ACTIVITIES = new Set(['Working', 'Thinking', 'Retrying', 'Compacting context'])

export interface HostWorkActivity {
  isStreaming?: boolean | undefined
  activity?: string | undefined
  liveTools?: readonly { status: string }[] | undefined
  dispatching?: boolean | undefined
  flowTaskStatuses?: readonly string[] | undefined
  browserTaskStatus?: string | null | undefined
}

// True only for work that is actually executing. Idle queue rows, paused flows, review dialogs, and scheduled jobs do not count.
export function hostWorkIsRunning(input: HostWorkActivity): boolean {
  if (input.isStreaming) return true
  if (input.activity && RUNNING_ACTIVITIES.has(input.activity)) return true
  if (input.dispatching) return true
  if (input.liveTools?.some((tool) => tool.status === 'running' || tool.status === 'preparing')) return true
  if (input.flowTaskStatuses?.some((status) => status === 'starting' || status === 'running')) return true
  return input.browserTaskStatus === 'running'
}

export function shouldInhibitSleep(when: 'off' | 'whileWorking' | 'whileAppOpen', working: boolean): boolean {
  if (when === 'off') return false
  if (when === 'whileAppOpen') return true
  return working
}
