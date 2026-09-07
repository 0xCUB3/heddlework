import { describe, expect, it } from 'bun:test'
import { createInitialState, isDraftConversation } from '../src/workbench/state.ts'

describe('isDraftConversation', () => {
  it('treats an idle empty thread as a new draft', () => {
    expect(isDraftConversation(createInitialState('/tmp/project'))).toBe(true)
  })

  it('keeps the transcript mounted while a sidebar click is opening a thread', () => {
    const state = {
      ...createInitialState('/tmp/project'),
      activity: 'Opening thread',
      connection: 'connecting' as const,
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/thread.jsonl', sessionId: 'thread' },
    }
    expect(isDraftConversation(state)).toBe(false)
  })

  it('returns to the draft chooser after an empty thread finishes opening', () => {
    const state = {
      ...createInitialState('/tmp/project'),
      activity: 'Ready',
      connection: 'connected' as const,
    }
    expect(isDraftConversation(state)).toBe(true)
  })
})
