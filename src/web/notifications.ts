import type { WorkspaceClient, WorkspaceClientView } from './client.ts'

export interface NotificationSink {
  hidden(): boolean
  notify(title: string, body: string): void
}

export function workspaceBasename(path: string): string {
  const parts = path.split(/[/\\]/).filter(Boolean)
  return parts.at(-1) ?? path
}

export function requestWorkspaceNotifications(): Promise<boolean> {
  if (typeof Notification === 'undefined') return Promise.resolve(false)
  if (Notification.permission === 'granted') return Promise.resolve(true)
  if (Notification.permission === 'denied') return Promise.resolve(false)
  return Notification.requestPermission().then((value) => value === 'granted')
}

export function watchWorkspaceNotifications(client: WorkspaceClient, sink: NotificationSink = browserNotificationSink()): () => void {
  let previous = client.getSnapshot()
  return client.subscribe(() => {
    const next = client.getSnapshot()
    if (sink.hidden()) maybeNotify(previous, next, sink)
    previous = next
  })
}

export function maybeNotify(previous: WorkspaceClientView, next: WorkspaceClientView, sink: NotificationSink): void {
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
    notify(title, body) {
      if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
      new Notification(title, { body })
    },
  }
}
