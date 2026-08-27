import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { PiForkMessage, PiMessage } from '../src/pi/types.ts'
import { Transcript, transcriptMessageWindow } from '../src/ui/transcript.tsx'
import { createInitialState } from '../src/workbench/state.ts'

const messages: PiMessage[] = Array.from({ length: 120 }, (_, index): PiMessage[] => [
  { role: 'user', content: `Prompt ${index}`, timestamp: index * 2 },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${index}` }], timestamp: index * 2 + 1 },
]).flat()
const forkMessages: PiForkMessage[] = Array.from({ length: 120 }, (_, index) => ({ entryId: `entry-${index}`, text: `Prompt ${index}` }))

describe('transcript message window', () => {
  it('projects only a tail page while preserving fork identity', () => {
    const page = transcriptMessageWindow(messages, forkMessages, 80)
    expect(page.hasOlder).toBe(true)
    expect(page.messages).toHaveLength(80)
    expect(page.messages[0]?.content).toBe('Prompt 80')
    expect(page.messages.at(-1)?.role).toBe('assistant')
    expect(page.forkMessages[0]?.entryId).toBe('entry-80')
  })
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('reverse-infinite transcript', () => {
  it('loads earlier pages without constructing the whole session', async () => {
    const state = {
      ...createInitialState('/tmp/long-project'),
      connection: 'connected' as const,
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/long.jsonl', sessionId: 'long' },
      messages,
      forkMessages,
    }
    const root = createTestRoot()
    root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )
    const automation = await connectTest(root.renderer)

    const initialText = root.renderer.getAllText()
    expect(initialText).toContain('Prompt 80')
    expect(initialText).not.toContain('Prompt 0')
    const list = (await automation.getByTestId('transcript-list').all())[0]!
    const surface = (await automation.getByTestId('transcript-scroll-surface').all())[0]!
    expect(surface.events).toContain('scroll')
    expect(await automation.getByTestId('load-earlier-messages').count()).toBe(0)
    expect(root.renderer.getAllText()).not.toContain('Load earlier messages')

    const listBounds = await automation.getByTestId('transcript-scroll-surface').bounds()
    root.renderer.scrollTo(list.id, 0, 0)
    root.renderer.flush()
    await automation.call('scrollWheel', { x: listBounds.x + listBounds.width / 2, y: listBounds.y + 8, deltaX: 0, deltaY: 10_000 })
    await Bun.sleep(25)
    root.renderer.flush()
    expect(root.renderer.getAllText()).toContain('Prompt 40')
    expect(root.renderer.getAllText()).not.toContain('Prompt 0')

    await automation.close()
    root.unmount()
  })

  it('follows a streaming tail only until the reader scrolls away', async () => {
    const root = createTestRoot()
    const base = {
      ...createInitialState('/tmp/stream-project'),
      connection: 'connected' as const,
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: true, sessionFile: '/tmp/stream.jsonl', sessionId: 'stream' },
      messages: messages.slice(-60),
      forkMessages: forkMessages.slice(-30),
      notices: [
        { id: 1, kind: 'info' as const, message: 'First notice', createdAt: 1 },
        { id: 2, kind: 'warning' as const, message: 'Second notice', createdAt: 2 },
      ],
    }
    const render = (text: string) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={{ ...base, liveAssistant: { id: 'live', blocks: [{ index: 0, kind: 'text', text }] } }} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )
    render('Streaming answer')
    const automation = await connectTest(root.renderer)
    const list = (await automation.getByTestId('transcript-list').all())[0]!
    expect(list.customProps?.followTail).toBe(true)
    expect((await automation.getByTestId('composer-spacer').bounds()).height).toBe(260)
    const beforeGrowth = root.renderer.getScrollOffset(list.id)?.[1] ?? 0

    render(Array.from({ length: 30 }, (_, index) => `Streaming line ${index}`).join('\n'))
    root.renderer.flush()
    const afterGrowth = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(afterGrowth).toBeLessThanOrEqual(beforeGrowth)

    const surfaceBounds = await automation.getByTestId('transcript-scroll-surface').bounds()
    await automation.call('scrollWheel', { x: surfaceBounds.x + surfaceBounds.width / 2, y: surfaceBounds.y + 40, deltaX: 0, deltaY: 600 })
    await Bun.sleep(25)
    root.renderer.flush()
    const userOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect((await automation.getByTestId('transcript-list').all())[0]!.customProps?.followTail).toBe(false)

    render(Array.from({ length: 60 }, (_, index) => `Streaming line ${index}`).join('\n'))
    root.renderer.flush()
    expect(Math.abs((root.renderer.getScrollOffset(list.id)?.[1] ?? 0) - userOffset)).toBeLessThan(2)

    await automation.close()
    root.unmount()
  })
})
