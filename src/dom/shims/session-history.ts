import type { PiMessage } from '../../pi/types.ts'

export const SESSION_HISTORY_PAGE_MESSAGES = 80
export const SESSION_HISTORY_PAGE_CONVERSATION_MESSAGES = 12
export const SESSION_HISTORY_PAGE_MAX_MESSAGES = 1_200

export interface SessionHistoryPage { messages: PiMessage[]; hasOlder: boolean; cursor?: number }
export interface SessionHistoryLoadOptions { conversationMessages?: number; maxMessages?: number }

// Flow activity previews load from disk on the desktop; the browser shows the live snapshot only.
export class PiSessionHistoryPager {
  constructor(_path: string) {}
  loadEarlier(_limit?: number, _options?: SessionHistoryLoadOptions): Promise<SessionHistoryPage> {
    return Promise.resolve({ messages: [], hasOlder: false })
  }
}
