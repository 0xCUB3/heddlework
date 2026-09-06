import type { AttentionEvent } from '../protocol/messages.ts'
import type { WorkspaceClient, WorkspaceClientView } from './client.ts'

export interface NotificationSink {
  hidden(): boolean
  notify(title: string, body: string, tag?: string): void
}

const fired = new Set<string>()

export function workspaceBasename(path: string): string {
  const parts = path.split(/[/\\]/).filter((part) => part && part !== '.')
  return parts.at(-1) || 'workspace'
}

export function requestWorkspaceNotifications(): Promise<boolean> {
  if (typeof Notification === 'undefined') return Promise.resolve(false)
  if (Notification.permission === 'granted') return Promise.resolve(true)
  if (Notification.permission === 'denied') return Promise.resolve(false)
  return Notification.requestPermission().then((value) => value === 'granted')
}

export function watchWorkspaceNotifications(client: WorkspaceClient, sink: NotificationSink = browserNotificationSink()): () => void {
  const stopAttention = client.onAttention((event) => {
    deliverAttention(event, sink)
  })
  let previous = client.getSnapshot()
  const stopState = client.subscribe(() => {
    const next = client.getSnapshot()
    if (sink.hidden()) maybeNotify(previous, next, sink)
    previous = next
  })
  return () => {
    stopAttention()
    stopState()
  }
}

export function deliverAttention(event: AttentionEvent, sink: NotificationSink): void {
  if (fired.has(event.eventId)) return
  fired.add(event.eventId)
  sink.notify(event.title, event.body, event.eventId)
}

export function maybeNotify(previous: WorkspaceClientView, next: WorkspaceClientView, sink: NotificationSink): void {
  if (!sink.hidden()) return
  const notices = next.state?.notices ?? []
  if (notices.some((notice) => notice.eventId || notice.channel)) return
  const name = workspaceBasename(next.workspacePath || previous.workspacePath)
  if (previous.state?.session.isStreaming && next.state && !next.state.session.isStreaming) {
    sink.notify(name, 'Turn finished')
  }
  if (!previous.state?.dialog && next.state?.dialog) {
    sink.notify(name, next.state.dialog.title)
  }
}

function browserNotificationSink(): NotificationSink {
  return {
    hidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
    notify(title, body, tag) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      new Notification(title, { body, ...(tag ? { tag } : {}) })
    },
  }
}
