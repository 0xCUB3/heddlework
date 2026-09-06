import { DESKTOP_CLIENT_ID, routeAttention } from '../workbench/presence.ts'
import { attentionBody, isLedgerNotice, noticeHeadline, type Notice } from '../workbench/notices.ts'
import type { WorkbenchController } from '../workbench/controller.ts'

const fired = new Set<string>()

export function requestOsNotifications(): Promise<boolean> {
  if (typeof Notification === 'undefined') return Promise.resolve(false)
  if (Notification.permission === 'granted') return Promise.resolve(true)
  if (Notification.permission === 'denied') return Promise.resolve(false)
  return Notification.requestPermission().then((value) => value === 'granted')
}

export function osNotificationCapability(): { available: boolean; permission: string; relayRequired: boolean } {
  const permission = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
  return {
    available: permission === 'granted',
    permission,
    relayRequired: true,
  }
}

export function showOsNotification(title: string, body: string, tag?: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body, ...(tag ? { tag } : {}), silent: false })
  } catch {
    // Some native shells expose Notification but reject construction.
  }
}

export function watchDesktopAttention(controller: WorkbenchController): () => void {
  let previous = new Set(controller.getSnapshot().notices.filter(isLedgerNotice).map((notice) => notice.eventId ?? `id:${notice.id}`))
  return controller.subscribe(() => {
    const state = controller.getSnapshot()
    const clients = controller.presence.list()
    for (const notice of state.notices) {
      if (!isLedgerNotice(notice)) continue
      const eventId = notice.eventId ?? `id:${notice.id}`
      if (previous.has(eventId) || fired.has(eventId)) continue
      const targets = routeAttention({
        createdAt: notice.createdAt,
        ...(notice.sessionPath ? { sessionPath: notice.sessionPath } : {}),
      }, clients)
      if (!targets.includes(DESKTOP_CLIENT_ID)) continue
      fired.add(eventId)
      showOsNotification(noticeHeadline(notice), attentionBody(notice), eventId)
    }
    previous = new Set(state.notices.filter(isLedgerNotice).map((notice) => notice.eventId ?? `id:${notice.id}`))
  })
}

export function rememberFiredNotice(eventId: string): void {
  fired.add(eventId)
}

export function hasFiredNotice(eventId: string): boolean {
  return fired.has(eventId)
}
