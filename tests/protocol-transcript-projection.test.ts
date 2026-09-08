import { describe, expect, it } from 'bun:test'
import type { PiMessage } from '../src/pi/types.ts'
import {
  applyWorkbenchCommand,
  estimateJsonBytes,
  estimateMessageBytes,
  findTranscriptDetail,
  projectTranscriptMessages,
  projectWorkbenchSnapshot,
  serializeSnapshot,
  TRANSCRIPT_BODY_BUDGET_BYTES,
  TRANSCRIPT_WIRE_BUDGET_BYTES,
} from '../src/protocol/index.ts'
import { createInitialState } from '../src/workbench/state.ts'

function toolResult(id: string, bytes: number): PiMessage {
  return {
    role: 'toolResult',
    workbenchEntryId: id,
    toolCallId: id,
    toolName: 'read',
    content: 'T'.repeat(bytes),
    timestamp: 1,
  }
}

describe('transcript wire projection', () => {
  it('stubs giant tool bodies under the wire budget and keeps a stable detailRef', () => {
    const messages = Array.from({ length: 80 }, (_, index) => toolResult('tool-' + index, 512 * 1024))
    const projected = projectTranscriptMessages(messages)
    expect(projected).toHaveLength(80)
    const payload = estimateMessageBytes({ role: 'bundle', content: JSON.stringify(projected) } as PiMessage)
    expect(payload).toBeLessThan(TRANSCRIPT_WIRE_BUDGET_BYTES)
    for (const message of projected) {
      expect(message.workbenchEntryId).toBeString()
      expect(message.detailRef).toMatchObject({ omitted: true, entryId: message.workbenchEntryId })
      expect(estimateMessageBytes(message)).toBeLessThan(TRANSCRIPT_BODY_BUDGET_BYTES * 2)
    }
    const original = messages[17]!
    const detail = findTranscriptDetail({ messages }, 'tool-17')
    expect(detail).toEqual({ kind: 'message', entryId: 'tool-17', message: original })
    expect(detail?.kind === 'message' ? detail.message.content : '').toHaveLength(512 * 1024)
  })

  it('reserves last prompt and answer instead of collapsing the page to tools', () => {
    const tools = Array.from({ length: 40 }, (_, index) => toolResult('tool-' + index, 160 * 1024))
    const prompt: PiMessage = { role: 'user', workbenchEntryId: 'prompt', content: 'P'.repeat(20 * 1024), timestamp: 2 }
    const answer: PiMessage = { role: 'assistant', workbenchEntryId: 'answer', content: 'A'.repeat(20 * 1024), timestamp: 3 }
    const projected = projectTranscriptMessages([...tools, prompt, answer])
    const lastPrompt = projected.find((message) => message.workbenchEntryId === 'prompt')
    const lastAnswer = projected.find((message) => message.workbenchEntryId === 'answer')
    expect(lastPrompt?.content).toBe(prompt.content)
    expect(lastAnswer?.content).toBe(answer.content)
    expect(lastPrompt?.detailRef).toBeUndefined()
    expect(projected[0]?.detailRef).toMatchObject({ omitted: true, entryId: 'tool-0' })
  })

  it('does not rewrite a small transcript array identity', () => {
    const messages: PiMessage[] = [
      { role: 'user', workbenchEntryId: 'u', content: 'hi' },
      { role: 'assistant', workbenchEntryId: 'a', content: 'hello' },
    ]
    expect(projectTranscriptMessages(messages)).toBe(messages)
  })

  it('projects a snapshot before send without dropping entry ids', () => {
    const state = createInitialState('/tmp/project')
    const messages = [
      toolResult('giant', 256 * 1024),
      { role: 'user' as const, workbenchEntryId: 'u', content: 'what happened?' },
    ]
    const snapshot = projectWorkbenchSnapshot(serializeSnapshot({ ...state, messages }))
    expect(snapshot.messages[0]?.workbenchEntryId).toBe('giant')
    expect(snapshot.messages[0]?.detailRef).toMatchObject({ omitted: true, entryId: 'giant' })
    expect(snapshot.messages[1]).toBe(messages[1])
  })

  it('stubs giant toolCall arguments instead of shipping them on the wire', () => {
    const cmd = 'x'.repeat(2 * 1024 * 1024)
    const messages: PiMessage[] = [{
      role: 'assistant',
      workbenchEntryId: 'call-1',
      content: [{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { cmd } }],
      timestamp: 1,
    }]
    const projected = projectTranscriptMessages(messages)
    const bytes = estimateJsonBytes(projected)
    expect(bytes).toBeLessThan(TRANSCRIPT_WIRE_BUDGET_BYTES)
    expect(bytes).toBeLessThan(16 * 1024)
    expect(projected[0]?.detailRef).toMatchObject({ omitted: true, entryId: 'call-1' })
    const args = Array.isArray(projected[0]?.content) ? projected[0]?.content[0]?.arguments : undefined
    expect(args).toBeUndefined()
  })

  it('does not reuse a projection cached for different budgets', () => {
    const messages: PiMessage[] = [{ role: 'user', workbenchEntryId: 'u', content: 'n'.repeat(4000), timestamp: 1 }]
    const wide = projectTranscriptMessages(messages, { bodyBudget: 8000, wireBudget: 64 * 1024 })
    const tight = projectTranscriptMessages(messages, { bodyBudget: 32, wireBudget: 1024 })
    expect(wide[0]?.detailRef).toBeUndefined()
    expect(tight[0]?.detailRef).toMatchObject({ omitted: true, entryId: 'u' })
  })

  it('does not invent colliding anonymous lookup ids', () => {
    const messages: PiMessage[] = [
      { role: 'assistant', content: 'a'.repeat(20_000), timestamp: 7 },
      { role: 'assistant', content: 'b'.repeat(20_000), timestamp: 7 },
    ]
    const projected = projectTranscriptMessages(messages)
    expect(projected[0]?.workbenchEntryId).not.toBe(projected[1]?.workbenchEntryId)
    expect(String(projected[0]?.workbenchEntryId).startsWith('anon:0:')).toBe(true)
    expect(findTranscriptDetail({ messages: projected }, projected[0]!.workbenchEntryId as string)).toBeUndefined()
  })
})

describe('getTranscriptDetail command', () => {
  it('returns the authoritative body by entry id, not array index', async () => {
    const giant = toolResult('keep-me', 64 * 1024)
    const other = toolResult('other', 32)
    const controller = {
      getSnapshot: () => ({ messages: [other, giant], liveTools: [] }),
    }
    const detail = await applyWorkbenchCommand(controller as never, { type: 'getTranscriptDetail', entryId: 'keep-me' }) as { kind: string; entryId: string; complete: boolean; message?: PiMessage }
    expect(detail.kind).toBe('message')
    expect(detail.entryId).toBe('keep-me')
    expect(detail.complete).toBe(true)
    expect(detail.message).toEqual(giant)
    await expect(applyWorkbenchCommand(controller as never, { type: 'getTranscriptDetail', entryId: 'missing' })).rejects.toThrow(/Unknown transcript entry/)
  })
})
