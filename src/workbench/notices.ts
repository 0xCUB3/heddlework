export type NoticeKind = 'info' | 'warning' | 'error'
export type NoticeChannel = 'toast' | 'ledger'
export type NoticeReason = 'local' | 'completion' | 'failure' | 'input' | 'status'

export interface NoticeAction {
  type: 'openSession'
  path: string
}

export interface Notice {
  id: number
  kind: NoticeKind
  message: string
  createdAt: number
  eventId?: string
  channel?: NoticeChannel
  reason?: NoticeReason
  sessionPath?: string
  sessionTitle?: string
  readAt?: number
  action?: NoticeAction
  transcriptTurn?: number
  transcriptPosition?: number
}

export interface NoticeOptions {
  channel?: NoticeChannel
  reason?: NoticeReason
  eventId?: string
  sessionPath?: string
  sessionTitle?: string
  action?: NoticeAction
  transcriptPosition?: number
  createdAt?: number
}

export const LEDGER_RETENTION = 50
export const TOAST_RETENTION = 5

const TOAST_EXACT = new Set([
  'Link copied',
  'Copied last assistant message to clipboard',
  'Queue is empty',
  'Navigated within the current Pi session',
  'Cloned thread into a new Pi session',
  'Branched from the selected turn',
  'Thread moved to Settled',
  'Thread returned to Active',
  'Context compacted',
  'Pause armed; in-flight tools will finish before Pi stops',
])

export function classifyNotice(kind: NoticeKind, message: string, options: NoticeOptions = {}): { channel: NoticeChannel; reason: NoticeReason } {
  if (options.channel && options.reason) return { channel: options.channel, reason: options.reason }
  if (options.reason) {
    const channel: NoticeChannel = options.reason === 'local' ? 'toast' : options.reason === 'status' && kind !== 'error' ? 'toast' : 'ledger'
    return { channel: options.channel ?? channel, reason: options.reason }
  }
  if (options.channel) {
    return { channel: options.channel, reason: options.channel === 'toast' ? 'local' : kind === 'error' ? 'failure' : 'status' }
  }
  if (message.includes('reconnecting automatically')) return { channel: 'toast', reason: 'status' }
  if (message.includes('Reconnect Pi before')) return { channel: 'toast', reason: 'status' }
  if (kind === 'error') return { channel: 'ledger', reason: 'failure' }
  if (message.startsWith('Heddlework ') && (message.includes('is available') || message.includes('is downloaded'))) return { channel: 'ledger', reason: 'status' }
  if (TOAST_EXACT.has(message) || message.startsWith('Snoozed until ') || message.startsWith('Exported session') || message.startsWith('Session name') || message.startsWith('Session exported') || message.startsWith('Merged lane ') || message.includes(' queued')) {
    return { channel: 'toast', reason: 'local' }
  }
  if (kind === 'warning') return { channel: 'ledger', reason: 'failure' }
  return { channel: 'toast', reason: 'local' }
}

export function isToastNotice(notice: Notice): boolean {
  return notice.channel === 'toast'
}

export function isLedgerNotice(notice: Notice): boolean {
  return notice.channel !== 'toast'
}

export function ledgerNotices(notices: readonly Notice[]): Notice[] {
  return notices.filter(isLedgerNotice)
}

export function toastNotices(notices: readonly Notice[]): Notice[] {
  return notices.filter(isToastNotice)
}

export function unreadLedgerNotices(notices: readonly Notice[]): Notice[] {
  return notices.filter((notice) => isLedgerNotice(notice) && notice.readAt === undefined)
}

export function appendNotice(notices: readonly Notice[], notice: Notice): Notice[] {
  const eventId = notice.eventId
  if (eventId && notices.some((candidate) => candidate.eventId === eventId)) return [...notices]
  return boundNotices([...notices, notice])
}

export function boundNotices(notices: readonly Notice[]): Notice[] {
  const toasts = toastNotices(notices).slice(-TOAST_RETENTION)
  const ledger = ledgerNotices(notices).slice(-LEDGER_RETENTION)
  return [...toasts, ...ledger].sort((left, right) => left.id - right.id)
}

export function markNoticeRead(notices: readonly Notice[], id: number, at = Date.now()): Notice[] {
  return notices.map((notice) => notice.id === id && notice.readAt === undefined ? { ...notice, readAt: at } : notice)
}

export function markLedgerRead(notices: readonly Notice[], at = Date.now()): Notice[] {
  return notices.map((notice) => isLedgerNotice(notice) && notice.readAt === undefined ? { ...notice, readAt: at } : notice)
}

export function noticeHeadline(notice: Notice): string {
  if (notice.reason === 'completion') return notice.sessionTitle ? `${notice.sessionTitle} finished` : 'Turn finished'
  if (notice.reason === 'input') return 'Input needed'
  if (notice.reason === 'failure') return 'Needs attention'
  return notice.sessionTitle || 'Heddlework'
}

export function attentionBody(notice: Notice): string {
  return notice.message
}
