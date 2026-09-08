import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { PiMessage } from '../src/pi/types.ts'
import {
  historicalTextRowBodyExecutionsSnapshot,
  resetHistoricalTextRowBodyExecutions,
  Transcript,
} from '../src/ui/transcript.tsx'
import {
  adaptiveWindowSize,
  GIANT_MARKDOWN_CHAR_THRESHOLD,
  TRANSCRIPT_VIRTUAL_WINDOW_SIZE,
} from '../src/ui/virtual-window.ts'
import { createInitialState } from '../src/workbench/state.ts'
import type { ToolRun } from '../src/workbench/state.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

function paintedText(root: { renderer: { getPaintedText(): string | string[] } }): string {
  return ([] as string[]).concat(root.renderer.getPaintedText()).join('\n')
}

function longMessages(turns: number): PiMessage[] {
  return Array.from({ length: turns }, (_, index): PiMessage[] => [
    { role: 'user', workbenchEntryId: `user-${index}`, content: `Prompt ${index}`, timestamp: index * 2 },
    { role: 'assistant', workbenchEntryId: `assistant-${index}`, content: `Answer ${index}`, timestamp: index * 2 + 1 },
  ]).flat()
}

describeNative('native transcript window', () => {
  it('does not backfill history on mount, but still loads on upward scroll intent', async () => {
    let loads = 0
    const state = { ...createInitialState('/tmp/history-intent'), messages: longMessages(2), messagesHasOlder: true }
    const root = createTestRoot({ width: 900, height: 640 })
    try {
      root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} onLoadEarlier={() => { loads++ }} /></div>)
      root.renderer.flush()
      await Bun.sleep(50)
      root.renderer.flush()
      expect(loads).toBe(0)
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, 240)
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(loads).toBeGreaterThan(0)
    } finally { root.unmount() }
  })

  it('paints the latest message when an empty selected session receives its disk preview', async () => {
    const state = { ...createInitialState('/tmp/preview-tail'), session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/preview-tail.jsonl' } }
    const root = createTestRoot({ width: 900, height: 640 })
    const render = (messages: PiMessage[]) => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={{ ...state, messages }} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} /></div>)
    try {
      render([])
      root.renderer.flush()
      render(longMessages(60))
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(root.renderer.getPaintedText()).toContain('Answer 59')
    } finally { root.unmount() }
  })
  it('mounts a bounded React window for a 400-turn chat and keeps the tail painted', async () => {
    const state = {
      ...createInitialState('/tmp/windowed-transcript'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/windowed-transcript.jsonl', sessionId: 'windowed-transcript' },
      messages: longMessages(400),
    }
    const root = createTestRoot({ width: 900, height: 640 })
    root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )
    const automation = await connectTest(root.renderer)
    const list = root.renderer.findByTestId('transcript-list')!
    expect(Number(list.customProps?.itemCount ?? 0)).toBeGreaterThan(400)
    expect(list.children.length).toBeLessThanOrEqual(TRANSCRIPT_VIRTUAL_WINDOW_SIZE + 8)
    expect(root.renderer.getPaintedText()).toContain('Answer 399')
    expect(root.renderer.getPaintedText()).not.toContain('Prompt 0')

    root.renderer.scrollToItem(list.id, 0)
    root.renderer.flush()
    await Bun.sleep(25)
    root.renderer.flush()
    expect(root.renderer.findByTestId('transcript-list')!.children.length).toBeLessThanOrEqual(TRANSCRIPT_VIRTUAL_WINDOW_SIZE + 8)
    expect(root.renderer.getPaintedText()).toContain('Prompt 0')

    await automation.close()
    root.unmount()
  })

  it('does not re-execute historical text row bodies while live assistant text streams', async () => {
    const presenters = new Map()
    const historical = longMessages(12)
    const base = {
      ...createInitialState('/tmp/render-count-stream'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: true, sessionFile: '/tmp/render-count-stream.jsonl', sessionId: 'render-count-stream' },
      messages: historical,
    }
    const root = createTestRoot({ width: 900, height: 640 })
    const render = (text: string) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={{ ...base, liveAssistant: { id: 'live-1', blocks: [{ index: 0, kind: 'text', text }] } }} presenters={presenters} onOpenDiff={() => undefined} onRevert={() => undefined} onDismissNotice={() => undefined} />
      </div>,
    )
    try {
      resetHistoricalTextRowBodyExecutions()
      render('Hello')
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      const before = historicalTextRowBodyExecutionsSnapshot()
      const historicalIds = [...before.keys()].filter((id) => !id.includes('live-1'))
      expect(historicalIds.length).toBeGreaterThan(0)
      render('Hello, here is a longer live token stream')
      root.renderer.flush()
      const after = historicalTextRowBodyExecutionsSnapshot()
      for (const id of historicalIds) {
        expect(after.get(id)).toBe(before.get(id))
      }
    } finally {
      root.unmount()
    }
  })

  it('does not re-execute historical text row bodies when an unrelated tool trace updates', async () => {
    const presenters = new Map()
    const historical = longMessages(10)
    const tool = (output: string): ToolRun => ({ id: 'live-tool-1', name: 'bash', args: { command: 'ls' }, output, status: 'running', isError: false })
    const base = {
      ...createInitialState('/tmp/render-count-tool'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: true, sessionFile: '/tmp/render-count-tool.jsonl', sessionId: 'render-count-tool' },
      messages: historical,
    }
    const root = createTestRoot({ width: 900, height: 640 })
    const render = (output: string) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={{ ...base, liveTools: [tool(output)] }} presenters={presenters} onOpenDiff={() => undefined} onRevert={() => undefined} onDismissNotice={() => undefined} />
      </div>,
    )
    try {
      resetHistoricalTextRowBodyExecutions()
      render('first')
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      const before = historicalTextRowBodyExecutionsSnapshot()
      const historicalIds = [...before.keys()].filter((id) => !id.includes('live-tool') && !id.includes('work-trace'))
      expect(historicalIds.length).toBeGreaterThan(0)
      render('first\nsecond line of tool output')
      root.renderer.flush()
      const after = historicalTextRowBodyExecutionsSnapshot()
      for (const id of historicalIds) {
        expect(after.get(id)).toBe(before.get(id))
      }
    } finally {
      root.unmount()
    }
  })

  it('windows a giant markdown message as blocks inside the adaptive viewport', async () => {
    const giant = Array.from({ length: 200 }, (_, index) => `Paragraph ${index} ${'x'.repeat(220)}`).join('\n\n')
    expect(giant.length).toBeGreaterThan(GIANT_MARKDOWN_CHAR_THRESHOLD)
    const state = {
      ...createInitialState('/tmp/giant-markdown'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/giant-markdown.jsonl', sessionId: 'giant-markdown' },
      messages: [
        { role: 'user', workbenchEntryId: 'giant-user', content: 'Write a long answer', timestamp: 1 },
        { role: 'assistant', workbenchEntryId: 'giant-assistant', content: giant, timestamp: 2 },
      ] satisfies PiMessage[],
    }
    const root = createTestRoot({ width: 900, height: 640 })
    try {
      root.render(
        <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
          <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
        </div>,
      )
      root.renderer.flush()
      const list = root.renderer.findByTestId('transcript-list')!
      const itemCount = Number(list.customProps?.itemCount ?? 0)
      const painted = ([] as string[]).concat(root.renderer.getPaintedText() as string | string[]).join('\n')
      expect(itemCount).toBeGreaterThan(40)
      expect(list.children.length).toBeLessThanOrEqual(TRANSCRIPT_VIRTUAL_WINDOW_SIZE + 8)
      expect(list.children.length).toBeLessThan(itemCount)
      expect(painted).toContain('Paragraph 199')
      expect(painted).not.toContain('Paragraph 0')
    } finally {
      root.unmount()
    }
  })

  it('uses a replaced parent revert handler without re-executing historical text rows', async () => {
    const historical = longMessages(8)
    const base = {
      ...createInitialState('/tmp/handler-replace'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: true, sessionFile: '/tmp/handler-replace.jsonl', sessionId: 'handler-replace' },
      messages: historical,
    }
    const calls: string[] = []
    let generation = 'first'
    const root = createTestRoot({ width: 900, height: 640 })
    const render = (text: string) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript
          state={{ ...base, liveAssistant: { id: 'live-1', blocks: [{ index: 0, kind: 'text', text }] } }}
          presenters={new Map()}
          onOpenDiff={() => undefined}
          onDismissNotice={() => undefined}
          onRevert={(entryId) => { calls.push(`${generation}:${entryId}`) }}
        />
      </div>,
    )
    try {
      resetHistoricalTextRowBodyExecutions()
      render('Hello')
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      const before = historicalTextRowBodyExecutionsSnapshot()
      const historicalIds = [...before.keys()].filter((id) => !id.includes('live-1'))
      expect(historicalIds.length).toBeGreaterThan(0)
      generation = 'second'
      render('Hello, replacement handler')
      root.renderer.flush()
      const after = historicalTextRowBodyExecutionsSnapshot()
      for (const id of historicalIds) expect(after.get(id)).toBe(before.get(id))
      const treeActions = root.renderer.findByType('div').filter((node) => node.testId === 'tree-message')
      expect(treeActions.length).toBeGreaterThan(0)
      const target = treeActions.at(-1)!
      const bounds = root.renderer.getElementBounds(target.id)
      expect(bounds).toBeTruthy()
      root.renderer.nativeSimulateClick(bounds![0]! + 8, bounds![1]! + 8)
      root.renderer.dispatchNativeEvents()
      root.renderer.flush()
      expect(calls.some((call) => call.startsWith('second:'))).toBe(true)
      expect(calls.some((call) => call.startsWith('first:'))).toBe(false)
    } finally {
      root.unmount()
    }
  })

  it('loads complete detail for a projected stub without mutating the original message', async () => {
    const stubContent = 'Preview of a huge answer…'
    const full = `Complete restored answer ${'word '.repeat(400)}`
    const stub: PiMessage = {
      role: 'assistant',
      workbenchEntryId: 'stub-entry',
      content: stubContent,
      timestamp: 2,
      detailRef: { entryId: 'stub-entry', bytes: 80_000, omitted: true, preview: stubContent },
    }
    const original = stub
    let loaded: string | undefined
    const root = createTestRoot({ width: 900, height: 640 })
    const presenters = new Map()
    const render = (messages: PiMessage[], loader?: (entryId: string) => Promise<void>) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript
          state={{
            ...createInitialState('/tmp/stub-detail'),
            session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/stub-detail.jsonl', sessionId: 'stub-detail' },
            messages: [
              { role: 'user', workbenchEntryId: 'stub-user', content: 'Ask', timestamp: 1 },
              ...messages,
            ],
          }}
          presenters={presenters}
          onOpenDiff={() => undefined}
          onRevert={() => undefined}
          {...(loader ? { onLoadDetail: loader } : {})}
        />
      </div>,
    )
    try {
      render([stub], async (entryId) => {
        loaded = entryId
        throw new Error('offline')
      })
      root.renderer.flush()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(loaded).toBe('stub-entry')
      expect(stub).toBe(original)
      expect(stub.content).toBe(stubContent)
      expect(root.renderer.findByTestId('transcript-detail-error')).toBeTruthy()
      expect(root.renderer.findByTestId('transcript-load-detail')).toBeTruthy()
      const automation = await connectTest(root.renderer)
      await automation.getByTestId('transcript-load-detail').click()
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(loaded).toBe('stub-entry')
      expect(root.renderer.findByTestId('transcript-detail-error')).toBeTruthy()
      await automation.close()
      render([{ role: 'assistant', workbenchEntryId: 'stub-entry', content: full, timestamp: 2 }])
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(paintedText(root)).toContain('Complete restored answer')
      expect(root.renderer.findByTestId('transcript-load-detail')).toBeUndefined()
      expect(original.content).toBe(stubContent)
    } finally {
      root.unmount()
    }
  })

  it('keeps streaming block ids stable when a giant answer completes', async () => {
    const prefix = Array.from({ length: 40 }, (_, index) => `Paragraph ${index} ${'x'.repeat(220)}`).join('\n\n')
    expect(prefix.length).toBeGreaterThan(GIANT_MARKDOWN_CHAR_THRESHOLD)
    const root = createTestRoot({ width: 900, height: 640 })
    const base = {
      ...createInitialState('/tmp/stream-blocks'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: true, sessionFile: '/tmp/stream-blocks.jsonl', sessionId: 'stream-blocks' },
      messages: [{ role: 'user', workbenchEntryId: 'stream-user', content: 'Write a long answer', timestamp: 1 }] satisfies PiMessage[],
    }
    const render = (streaming: boolean, text: string) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript
          state={streaming
            ? { ...base, liveAssistant: { id: 'live-giant', blocks: [{ index: 0, kind: 'text', text }] } }
            : { ...base, session: { ...base.session, isStreaming: false }, messages: [...base.messages, { role: 'assistant', workbenchEntryId: 'live-giant', content: text, timestamp: 2 }] }}
          presenters={new Map()}
          onOpenDiff={() => undefined}
          onRevert={() => undefined}
        />
      </div>,
    )
    try {
      render(true, prefix)
      root.renderer.flush()
      const streamingList = root.renderer.findByTestId('transcript-list')!
      const streamingCount = Number(streamingList.customProps?.itemCount ?? 0)
      const streamingMounted = streamingList.children.length
      const streamingRows = Math.max(streamingCount, streamingMounted)
      expect(streamingRows).toBeGreaterThan(1)
      expect(streamingMounted).toBeGreaterThan(1)
      expect(paintedText(root)).toContain('Paragraph 39')
      render(false, `${prefix}\n\nParagraph done ${'x'.repeat(220)}`)
      root.renderer.flush()
      const completedList = root.renderer.findByTestId('transcript-list')!
      expect(Number(completedList.customProps?.itemCount ?? 0)).toBeGreaterThanOrEqual(streamingCount)
      expect(paintedText(root)).toContain('Paragraph done')
    } finally {
      root.unmount()
    }
  })

  it('mounts fewer rows in a short window than in a tall one', async () => {
    const state = {
      ...createInitialState('/tmp/viewport-geometry'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/viewport-geometry.jsonl', sessionId: 'viewport-geometry' },
      messages: longMessages(400),
    }
    const short = createTestRoot({ width: 900, height: 360 })
    const tall = createTestRoot({ width: 900, height: 1200 })
    try {
      short.render(<div style={{ width: 900, height: 360, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} /></div>)
      tall.render(<div style={{ width: 900, height: 1200, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} /></div>)
      short.renderer.flush()
      tall.renderer.flush()
      await Bun.sleep(40)
      short.renderer.flush()
      tall.renderer.flush()
      const shortCount = short.renderer.findByTestId('transcript-list')!.children.length
      const tallCount = tall.renderer.findByTestId('transcript-list')!.children.length
      expect(shortCount).toBeLessThanOrEqual(TRANSCRIPT_VIRTUAL_WINDOW_SIZE)
      expect(tallCount).toBeLessThanOrEqual(TRANSCRIPT_VIRTUAL_WINDOW_SIZE)
      const shortHeight = short.renderer.getWindowSize?.()?.height ?? 360
      const tallHeight = tall.renderer.getWindowSize?.()?.height ?? 1200
      if (shortHeight < tallHeight) expect(shortCount).toBeLessThanOrEqual(tallCount)
      expect(adaptiveWindowSize(8000, 40)).toBeGreaterThan(adaptiveWindowSize(360, 88))
    } finally {
      short.unmount()
      tall.unmount()
    }
  })

  it('does not require Load full output on a collapsed work trace', async () => {
    const tool = {
      id: 'live-stub-tool',
      name: 'bash',
      args: { command: 'cat huge.log' },
      output: 'truncated preview',
      status: 'complete' as const,
      isError: false,
      detailRef: { entryId: 'live-stub-tool', bytes: 28_000, omitted: true as const, preview: 'truncated preview' },
    }
    const root = createTestRoot({ width: 900, height: 640 })
    try {
      root.render(
        <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
          <Transcript
            state={{
              ...createInitialState('/tmp/collapsed-tool-stub'),
              session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/collapsed-tool-stub.jsonl', sessionId: 'collapsed-tool-stub' },
              messages: [
                { role: 'user', workbenchEntryId: 'live-user', content: 'Run it', timestamp: 1 },
                { role: 'assistant', workbenchEntryId: 'live-assistant', content: [{ type: 'toolCall', id: 'live-stub-tool', name: 'bash', arguments: { command: 'cat huge.log' } }], timestamp: 2 },
                { role: 'toolResult', workbenchEntryId: 'live-result', toolCallId: 'live-stub-tool', toolName: 'bash', content: 'truncated preview', timestamp: 3, detailRef: tool.detailRef },
                { role: 'assistant', workbenchEntryId: 'live-answer', content: 'Verified the full output.', timestamp: 4 },
              ],
              liveTools: [],
            }}
            presenters={new Map()}
            onOpenDiff={() => undefined}
            onRevert={() => undefined}
            onLoadDetail={async () => undefined}
          />
        </div>,
      )
      root.renderer.flush()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(paintedText(root)).toContain('Worked')
      expect(root.renderer.findByTestId('transcript-load-detail')).toBeUndefined()
      expect(paintedText(root)).toContain('Verified the full output.')
    } finally {
      root.unmount()
    }
  })

  it('hydrates an expanded live tool stub without mutating the original tool', async () => {
    const tool = {
      id: 'live-stub-tool',
      name: 'bash',
      args: { command: 'cat huge.log' },
      output: 'truncated preview',
      status: 'running' as const,
      isError: false,
      detailRef: { entryId: 'live-stub-tool', bytes: 120_000, omitted: true as const, preview: 'truncated preview' },
    }
    const original = tool.output
    let loaded: string | undefined
    const root = createTestRoot({ width: 900, height: 640 })
    try {
      root.render(
        <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
          <Transcript
            state={{
              ...createInitialState('/tmp/live-tool-stub'),
              session: { model: null, thinkingLevel: 'off' as const, isStreaming: true, sessionFile: '/tmp/live-tool-stub.jsonl', sessionId: 'live-tool-stub' },
              messages: [{ role: 'user', workbenchEntryId: 'live-user', content: 'Run it', timestamp: 1 }],
              liveTools: [tool],
            }}
            presenters={new Map()}
            onOpenDiff={() => undefined}
            onRevert={() => undefined}
            onLoadDetail={async (entryId) => { loaded = entryId }}
          />
        </div>,
      )
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(root.renderer.findByTestId('transcript-load-detail')).toBeUndefined()
      expect(tool.output).toBe(original)
      const automation = await connectTest(root.renderer)
      await automation.getByTestId('execution-trace-hit').click()
      root.renderer.flush()
      await Bun.sleep(40)
      root.renderer.flush()
      expect(loaded).toBe('live-stub-tool')
      expect(tool.output).toBe(original)
      await automation.close()
    } finally {
      root.unmount()
    }
  })

  it('keeps an explicit Load full output control for giant omitted bodies', async () => {
    const stub: PiMessage = {
      role: 'assistant',
      workbenchEntryId: 'giant-entry',
      content: 'Preview…',
      timestamp: 2,
      detailRef: { entryId: 'giant-entry', bytes: 8_000_000, omitted: true, preview: 'Preview…' },
    }
    const root = createTestRoot({ width: 900, height: 640 })
    try {
      root.render(
        <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
          <Transcript
            state={{
              ...createInitialState('/tmp/giant-detail'),
              session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/giant-detail.jsonl', sessionId: 'giant-detail' },
              messages: [
                { role: 'user', workbenchEntryId: 'giant-user', content: 'Ask', timestamp: 1 },
                stub,
              ],
            }}
            presenters={new Map()}
            onOpenDiff={() => undefined}
            onRevert={() => undefined}
            onLoadDetail={async () => undefined}
          />
        </div>,
      )
      root.renderer.flush()
      await Bun.sleep(25)
      root.renderer.flush()
      expect(root.renderer.findByTestId('transcript-load-detail')).toBeTruthy()
    } finally {
      root.unmount()
    }
  })
})
