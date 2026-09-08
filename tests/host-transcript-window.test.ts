import { describe, expect, it } from 'bun:test'
import { SESSION_HISTORY_PAGE_MESSAGES } from '../src/pi/session-history.ts'
import type { PiMessage } from '../src/pi/types.ts'
import { diffSnapshots, serializeSnapshot, type WorkbenchSnapshot } from '../src/protocol/snapshot.ts'
import type { ServerMessage } from '../src/protocol/index.ts'
import { pushSocketSnapshot, revealEarlierMessages, SOCKET_TRANSCRIPT_WINDOW_MESSAGES, withTranscriptWindow, type TranscriptWindow } from '../src/host/server-runtime.ts'
import { createInitialState, type WorkbenchState } from '../src/workbench/state.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'

function thread(count: number, prefix = 'm'): PiMessage[] {
  return Array.from({ length: count }, (_, index): PiMessage => ({ role: index % 2 ? 'assistant' : 'user', workbenchEntryId: `${prefix}-${index}`, content: `${prefix} ${index}`, timestamp: index }))
}

function state(messages: PiMessage[], hasOlder = false): WorkbenchState {
  const base = createInitialState('/tmp/window')
  return { ...base, connection: 'connected', session: { ...base.session, sessionFile: '/tmp/window.jsonl' }, messages, messagesHasOlder: hasOlder }
}

function fakeSocket() {
  return { data: { lastSnapshot: undefined as WorkbenchSnapshot | undefined, transcriptWindow: undefined as TranscriptWindow | undefined, previewTranscript: undefined } } as unknown as Bun.ServerWebSocket<{ lastSnapshot: WorkbenchSnapshot | undefined; transcriptWindow?: TranscriptWindow | undefined; previewTranscript?: undefined }>
}

function fakeController(initial: WorkbenchState) {
  let current = initial
  const older: PiMessage[] = thread(30, 'disk')
  return {
    getSnapshot: () => current,
    set: (next: WorkbenchState) => { current = next },
    loadEarlierMessages: async () => { current = { ...current, messages: [...older, ...current.messages], messagesHasOlder: false } },
  } as unknown as WorkbenchController & { set(next: WorkbenchState): void }
}

describe('socket transcript window', () => {
  it('sends only the tail of an oversized bundle transcript and marks older rows available', () => {
    const socket = fakeSocket()
    const all = thread(SOCKET_TRANSCRIPT_WINDOW_MESSAGES + 150)
    const next = withTranscriptWindow(socket, serializeSnapshot(state(all)))
    expect(next.messages).toHaveLength(SOCKET_TRANSCRIPT_WINDOW_MESSAGES)
    expect(next.messages[0]).toBe(all[150])
    expect(next.messagesHasOlder).toBe(true)
  })

  it('passes a short transcript through untouched', () => {
    const socket = fakeSocket()
    const snapshot = serializeSnapshot(state(thread(20), true))
    expect(withTranscriptWindow(socket, snapshot)).toBe(snapshot)
  })

  it('keeps the anchor while the tail grows so appends diff as a plain messages change', () => {
    const socket = fakeSocket()
    const all = thread(SOCKET_TRANSCRIPT_WINDOW_MESSAGES + 10)
    const first = withTranscriptWindow(socket, serializeSnapshot(state(all)))
    const grown = [...all, { role: 'user', workbenchEntryId: 'm-new', content: 'new', timestamp: 9999 } as PiMessage]
    const second = withTranscriptWindow(socket, serializeSnapshot(state(grown)))
    expect(second.messages[0]).toBe(first.messages[0])
    expect(second.messages).toHaveLength(SOCKET_TRANSCRIPT_WINDOW_MESSAGES + 1)
    expect(second.messages.at(-1)?.workbenchEntryId).toBe('m-new')
  })

  it('reveals in-memory pages on scroll-up as messagesPrepend before reaching the disk pager', async () => {
    const socket = fakeSocket()
    const all = thread(SOCKET_TRANSCRIPT_WINDOW_MESSAGES + 100)
    const controller = fakeController(state(all, true))
    const sent: ServerMessage[] = []
    const send = (_: unknown, message: ServerMessage) => { sent.push(message) }
    pushSocketSnapshot(send, socket, controller)
    expect(socket.data.lastSnapshot?.messages).toHaveLength(SOCKET_TRANSCRIPT_WINDOW_MESSAGES)
    sent.length = 0
    await revealEarlierMessages(send, socket, controller)
    expect(sent).toHaveLength(1)
    const patch = sent[0]!.kind === 'patch' ? sent[0]!.patch : undefined
    expect(patch?.messagesPrepend).toHaveLength(SESSION_HISTORY_PAGE_MESSAGES)
    expect(patch?.changed.messages).toBeUndefined()
    expect(socket.data.lastSnapshot?.messagesHasOlder).toBe(true)
    sent.length = 0
    await revealEarlierMessages(send, socket, controller)
    expect(socket.data.lastSnapshot?.messages[0]).toBe(all[0])
    expect(socket.data.lastSnapshot?.messagesHasOlder).toBe(true)
    sent.length = 0
    await revealEarlierMessages(send, socket, controller)
    const diskPatch = sent[0]!.kind === 'patch' ? sent[0]!.patch : undefined
    expect(diskPatch?.messagesPrepend).toHaveLength(30)
    expect(socket.data.lastSnapshot?.messagesHasOlder).toBe(false)
    expect(socket.data.lastSnapshot?.messages).toHaveLength(all.length + 30)
  })

  it('re-anchors when the session file changes', () => {
    const socket = fakeSocket()
    const a = withTranscriptWindow(socket, serializeSnapshot(state(thread(SOCKET_TRANSCRIPT_WINDOW_MESSAGES + 50, 'a'))))
    const other = state(thread(SOCKET_TRANSCRIPT_WINDOW_MESSAGES + 5, 'b'))
    const b = withTranscriptWindow(socket, serializeSnapshot({ ...other, session: { ...other.session, sessionFile: '/tmp/other.jsonl' } }))
    expect(a.messages[0]?.workbenchEntryId).toBe('a-50')
    expect(b.messages[0]?.workbenchEntryId).toBe('b-5')
    expect(diffSnapshots(a, b).changed.messages).toHaveLength(SOCKET_TRANSCRIPT_WINDOW_MESSAGES)
  })
})
