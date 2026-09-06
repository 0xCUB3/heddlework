import { describe, expect, it } from 'bun:test'
import { createInitialState } from '../src/workbench/state.ts'
import { addNotice } from '../src/workbench/state.ts'
import { deliverAttention, maybeNotify, workspaceBasename, type NotificationSink } from '../src/web/notifications.ts'
import type { WorkspaceClientView } from '../src/web/client.ts'

class MemorySink implements NotificationSink {
  hiddenValue = true
  events: Array<{ title: string; body: string; tag?: string }> = []
  hidden(): boolean { return this.hiddenValue }
  notify(title: string, body: string, tag?: string): void { this.events.push({ title, body, ...(tag ? { tag } : {}) }) }
}

function view(state = createInitialState('/tmp/project')): WorkspaceClientView {
  return { status: 'open', workspacePath: '/tmp/project', state, flows: undefined }
}

describe('web notification routing', () => {
  it('names a missing workspace instead of rendering a slash', () => {
    expect(workspaceBasename('/')).toBe('workspace')
    expect(workspaceBasename('')).toBe('workspace')
    expect(workspaceBasename('/Users/skula/projects/heddlework')).toBe('heddlework')
  })

  it('does not OS-notify copy toasts or snapshot patches when the host speaks attention events', () => {
    const sink = new MemorySink()
    const previous = view()
    let nextState = addNotice(createInitialState('/tmp/project'), 'info', 'Link copied')
    nextState = addNotice(nextState, 'error', 'Build failed')
    maybeNotify(previous, view(nextState), sink)
    expect(sink.events).toEqual([])

    const eventId = nextState.notices.at(-1)!.eventId!
    deliverAttention({ eventId, noticeId: nextState.notices.at(-1)!.id, title: 'Needs attention', body: 'Build failed' }, sink)
    expect(sink.events).toEqual([{ title: 'Needs attention', body: 'Build failed', tag: eventId }])
    deliverAttention({ eventId: nextState.notices.at(-1)!.eventId!, noticeId: nextState.notices.at(-1)!.id, title: 'Needs attention', body: 'Build failed' }, sink)
    expect(sink.events).toHaveLength(1)
  })
})
