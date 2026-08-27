import React from 'react'
import { performance } from 'node:perf_hooks'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { PiForkMessage, PiMessage } from '../src/pi/types.ts'
import { Transcript } from '../src/ui/transcript.tsx'
import { createInitialState } from '../src/workbench/state.ts'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { coreToolPresentersPlugin, toolPresenterSlot } from '../src/ui/tool-presenters.ts'
import { colors } from '../src/ui/theme.ts'

const messages: PiMessage[] = Array.from({ length: 120 }, (_, index): PiMessage[] => [
  { role: 'user', content: `Prompt ${index}`, timestamp: index * 2 },
  { role: 'assistant', content: [{ type: 'text', text: `Answer ${index}` }], timestamp: index * 2 + 1 },
]).flat()
const forkMessages: PiForkMessage[] = Array.from({ length: 120 }, (_, index) => ({ entryId: `entry-${index}`, text: `Prompt ${index}` }))

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('reverse-infinite transcript', () => {
  it('keeps one bottom-aligned native list while the reader changes direction', async () => {
    const state = {
      ...createInitialState('/tmp/long-project'),
      connection: 'connected' as const,
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/long.jsonl', sessionId: 'long' },
      messages,
      forkMessages,
    }
    const root = createTestRoot({ width: 900, height: 640 })
    root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )
    const automation = await connectTest(root.renderer)
    const list = root.renderer.findByTestId('transcript-list')!
    const listId = list.id
    expect(list.type).toBe('virtual-list')
    expect(list.customProps?.alignment).toBe('bottom')
    expect(list.customProps?.followTail).toBe(false)
    expect(root.renderer.getPaintedText()).toContain('Prompt 119')

    root.renderer.scrollToItem(list.id, 100)
    const middleOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    const bounds = await automation.getByTestId('transcript-scroll-surface').bounds()
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: 120 })
    root.renderer.flush()
    const upwardOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(upwardOffset).toBeGreaterThan(middleOffset)
    await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: -120 })
    root.renderer.flush()
    expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeLessThan(upwardOffset)
    expect(root.renderer.findByTestId('transcript-list')?.id).toBe(listId)

    await automation.close()
    root.unmount()
  })

  it('prefetches a persisted page without replacing or snapping the native list', async () => {
    const tail = messages.slice(-80).map((message, index) => ({ ...message, workbenchEntryId: `tail-${index}` }))
    const older = messages.slice(-160, -80).map((message, index) => ({ ...message, workbenchEntryId: `older-${index}` }))
    let loadCalls = 0
    let finishLoad: (() => void) | undefined

    function Fixture() {
      const [history, setHistory] = React.useState({ messages: tail, loading: false, hasOlder: true })
      const loadEarlier = () => {
        loadCalls += 1
        setHistory((current) => ({ ...current, loading: true }))
        return new Promise<void>((resolve) => {
          finishLoad = () => {
            setHistory({ messages: [...older, ...tail], loading: false, hasOlder: false })
            resolve()
          }
        })
      }
      const state = {
        ...createInitialState('/tmp/remote-history-project'),
        session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/remote-history.jsonl', sessionId: 'remote-history' },
        messages: history.messages,
        messagesHasOlder: history.hasOlder,
        messagesLoadingEarlier: history.loading,
      }
      return <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} onLoadEarlier={loadEarlier} />
    }

    const root = createTestRoot({ width: 920, height: 640 })
    root.render(<div style={{ width: 920, height: 640, display: 'flex', flexDirection: 'column' }}><Fixture /></div>)
    const automation = await connectTest(root.renderer)
    const list = root.renderer.findByTestId('transcript-list')!
    const listId = list.id
    root.renderer.scrollToItem(list.id, 12)
    const beforePrefetch = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(beforePrefetch).toBeLessThan(-900)
    expect(root.renderer.getPaintedText()).toContain('Prompt 86')
    const bounds = await automation.getByTestId('transcript-scroll-surface').bounds()

    for (let index = 0; index < 6; index += 1) {
      await automation.call('scrollWheel', { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, deltaX: 0, deltaY: 120 })
    }
    await Bun.sleep(10)
    root.renderer.flush()

    expect(loadCalls).toBe(1)
    expect(finishLoad).toBeDefined()
    expect(await automation.getByTestId('history-loading-skeleton').count()).toBe(1)
    expect(root.renderer.findByTestId('transcript-list')?.id).toBe(listId)
    expect(root.renderer.getPaintedText()).toContain('Prompt 83')
    const retainedPromptBefore = await automation.getByText('Prompt 84').bounds()

    finishLoad?.()
    await Bun.sleep(25)
    root.renderer.flush()

    expect(await automation.getByTestId('history-loading-skeleton').count()).toBe(0)
    const settledList = root.renderer.findByTestId('transcript-list')!
    const retainedPromptAfter = await automation.getByText('Prompt 84').bounds()
    expect(settledList.id).toBe(listId)
    expect(Math.abs(retainedPromptAfter.y - retainedPromptBefore.y)).toBeLessThan(2)
    expect(root.renderer.getPaintedText()).not.toContain('Prompt 40')
    const boundaryOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0

    await automation.call('scrollWheel', { x: bounds.x + bounds.width / 2, y: bounds.y + 40, deltaX: 0, deltaY: -120 })
    root.renderer.flush()
    const downwardOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(downwardOffset).toBeLessThan(boundaryOffset)
    await automation.call('scrollWheel', { x: bounds.x + bounds.width / 2, y: bounds.y + 40, deltaX: 0, deltaY: 60 })
    root.renderer.flush()
    expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeGreaterThan(downwardOffset)
    expect(root.renderer.findByTestId('transcript-list')?.id).toBe(listId)

    await automation.close()
    root.unmount()
  })

  it('keeps the retained first row in place when a page replaces the exact-top skeleton', async () => {
    const retained = Array.from({ length: 24 }, (_, index): PiMessage[] => [
      { role: 'user', workbenchEntryId: `retained-user-${index}`, content: `Retained prompt ${index}`, timestamp: 100 + index * 2 },
      { role: 'assistant', workbenchEntryId: `retained-answer-${index}`, content: `Retained answer ${index}`, timestamp: 101 + index * 2 },
    ]).flat()
    const older = Array.from({ length: 10 }, (_, index): PiMessage[] => [
      { role: 'user', workbenchEntryId: `older-user-${index}`, content: `Older prompt ${index}`, timestamp: index * 2 },
      { role: 'assistant', workbenchEntryId: `older-answer-${index}`, content: `Older answer ${index}`, timestamp: index * 2 + 1 },
    ]).flat()
    const forkCatalog: PiForkMessage[] = [
      ...Array.from({ length: 10 }, (_, index) => ({ entryId: `older-user-${index}`, text: `Older prompt ${index}` })),
      ...Array.from({ length: 24 }, (_, index) => ({ entryId: `retained-user-${index}`, text: `Retained prompt ${index}` })),
    ]
    const state = (history: PiMessage[], loading: boolean) => ({
      ...createInitialState('/tmp/exact-top-project'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/exact-top.jsonl', sessionId: 'exact-top' },
      messages: history,
      messagesHasOlder: false,
      messagesLoadingEarlier: loading,
      forkMessages: forkCatalog,
    })
    const root = createTestRoot({ width: 920, height: 640 })
    const render = (history: PiMessage[], loading: boolean) => root.render(
      <div style={{ width: 920, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state(history, loading)} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )

    render(retained, false)
    const list = root.renderer.findByTestId('transcript-list')!
    const listId = list.id
    const anchorRowId = list.children[0]!
    root.renderer.scrollToItem(list.id, 0)
    expect(Math.abs(root.renderer.getScrollOffset(list.id)?.[1] ?? 0)).toBeLessThan(1)
    const retainedBefore = root.renderer.findByTestId('user-message')!.id

    render(retained, true)
    root.renderer.flush()
    const loadingList = root.renderer.findByTestId('transcript-list')!
    expect(loadingList.children.indexOf(anchorRowId)).toBe(0)
    expect(root.renderer.findByTestId('user-message')?.id).toBe(retainedBefore)
    const loadingOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(Math.abs(loadingOffset)).toBeLessThan(1)

    render([...older, ...retained], false)
    root.renderer.flush()
    const settledList = root.renderer.findByTestId('transcript-list')!
    expect(settledList.id).toBe(listId)
    expect(settledList.children.indexOf(anchorRowId)).toBe(20)
    expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeLessThan(loadingOffset)
    expect(root.renderer.getPaintedText()).toContain('Retained prompt 0')

    root.unmount()
  })

  it('continues through collapsed-only pages until the reader gains scrollable history', async () => {
    const tail: PiMessage[] = [
      { role: 'assistant', workbenchEntryId: 'retained-trace', content: [{ type: 'thinking', thinking: 'Retained boundary reasoning' }], timestamp: 100 },
      { role: 'assistant', workbenchEntryId: 'tail-separator', content: 'Tail separator', timestamp: 101 },
      ...Array.from({ length: 22 }, (_, index): PiMessage[] => [
        { role: 'user', workbenchEntryId: `tail-user-${index}`, content: `Tail prompt ${index}`, timestamp: 200 + index * 2 },
        { role: 'assistant', workbenchEntryId: `tail-answer-${index}`, content: `Tail answer ${index}`, timestamp: 201 + index * 2 },
      ]).flat(),
    ]
    const pages: PiMessage[][] = [
      [{ role: 'assistant', workbenchEntryId: 'collapsed-page-1', content: [{ type: 'thinking', thinking: 'Collapsed page one' }], timestamp: 90 }],
      [{ role: 'assistant', workbenchEntryId: 'collapsed-page-2', content: [{ type: 'thinking', thinking: 'Collapsed page two' }], timestamp: 80 }],
      [
        { role: 'assistant', workbenchEntryId: 'older-separator', content: 'Older visible boundary', timestamp: 70 },
        { role: 'assistant', workbenchEntryId: 'collapsed-page-3', content: [{ type: 'thinking', thinking: 'Collapsed page three' }], timestamp: 71 },
      ],
    ]
    let loadCalls = 0

    function Fixture() {
      const [history, setHistory] = React.useState({ messages: tail, page: 0, loading: false })
      const loadEarlier = async () => {
        const page = pages[loadCalls]
        if (!page) return
        loadCalls += 1
        setHistory((current) => ({ ...current, loading: true }))
        await Bun.sleep(1)
        setHistory((current) => ({ messages: [...page, ...current.messages], page: current.page + 1, loading: false }))
      }
      const state = {
        ...createInitialState('/tmp/collapsed-pages-project'),
        session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/collapsed-pages.jsonl', sessionId: 'collapsed-pages' },
        messages: history.messages,
        messagesHasOlder: history.page < pages.length,
        messagesLoadingEarlier: history.loading,
      }
      return <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} onLoadEarlier={loadEarlier} />
    }

    const root = createTestRoot({ width: 920, height: 640 })
    root.render(<div style={{ width: 920, height: 640, display: 'flex', flexDirection: 'column' }}><Fixture /></div>)
    const list = root.renderer.findByTestId('transcript-list')!
    const listId = list.id
    const anchorRowId = list.children[0]!
    root.renderer.scrollToItem(list.id, 0)
    await Bun.sleep(80)
    root.renderer.flush()

    const settledList = root.renderer.findByTestId('transcript-list')!
    expect(loadCalls).toBe(3)
    expect(settledList.id).toBe(listId)
    expect(settledList.children.indexOf(anchorRowId)).toBe(1)
    expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeLessThan(0)
    expect(root.renderer.getPaintedText()).toContain('Tail separator')

    root.unmount()
  })

  it('keeps a short settled transcript movable after reaching its first prompt', async () => {
    const root = createTestRoot({ width: 920, height: 460 })
    const state = {
      ...createInitialState('/tmp/short-project'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/short.jsonl', sessionId: 'short' },
      messages: messages.slice(0, 24),
    }
    root.render(
      <div style={{ width: 920, height: 460, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )
    root.renderer.flush()
    const automation = await connectTest(root.renderer)
    const list = root.renderer.findByTestId('transcript-list')!
    const bounds = await automation.getByTestId('transcript-scroll-surface').bounds()
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + 40 }

    expect(root.renderer.getAllText()).toContain('Prompt 11')
    const bottomOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(bottomOffset).toBeLessThan(-100)
    await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: 10_000 })
    root.renderer.flush()
    const topOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(topOffset).toBeGreaterThanOrEqual(-1)

    await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: -120 })
    root.renderer.flush()
    expect(root.renderer.getScrollOffset(list.id)?.[1] ?? 0).toBeLessThan(topOffset)

    await automation.call('scrollWheel', { ...point, deltaX: 0, deltaY: -10_000 })
    root.renderer.flush()
    const returnedBottom = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(returnedBottom).toBeLessThan(-100)
    expect(root.renderer.getPaintedText()).toContain('Prompt 11')
    await automation.close()
    root.unmount()
  })

  it('requests persisted history when the active tail is shorter than the viewport', async () => {
    let loadCalls = 0
    const root = createTestRoot({ width: 920, height: 640 })
    const state = {
      ...createInitialState('/tmp/sparse-tail-project'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/sparse-tail.jsonl', sessionId: 'sparse-tail' },
      messages: messages.slice(-2),
      messagesHasOlder: true,
    }
    root.render(
      <div style={{ width: 920, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} onLoadEarlier={() => { loadCalls += 1 }} />
      </div>,
    )
    const automation = await connectTest(root.renderer)

    await automation.call('scrollWheel', { x: 460, y: 320, deltaX: 0, deltaY: 120 })
    await Bun.sleep(0)
    root.renderer.flush()

    expect(loadCalls).toBe(1)
    await automation.close()
    root.unmount()
  })

  it('resets a replacement session to its newest turn', async () => {
    const root = createTestRoot()
    const render = (sessionId: string) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript
          state={{
            ...createInitialState('/tmp/session-project'),
            connection: 'connected' as const,
            session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: `/tmp/${sessionId}.jsonl`, sessionId },
            messages: messages.slice(-80),
            forkMessages: forkMessages.slice(-40),
          }}
          presenters={new Map()}
          onOpenDiff={() => {}}
          onRevert={() => {}}
        />
      </div>,
    )

    render('session-a')
    const firstList = root.renderer.findByTestId('transcript-list')!
    root.renderer.scrollTo(firstList.id, 0, 0)
    expect(root.renderer.getScrollOffset(firstList.id)?.[1] ?? -1).toBeGreaterThanOrEqual(-1)

    render('session-b')
    await Bun.sleep(0)
    root.renderer.flush()
    const replacementList = root.renderer.findByTestId('transcript-list')!
    expect(replacementList.id).not.toBe(firstList.id)
    expect(root.renderer.getScrollOffset(replacementList.id)?.[1] ?? 0).toBeLessThan(-100)

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
    const list = root.renderer.findByTestId('transcript-list')!
    expect((await automation.getByTestId('composer-spacer').bounds()).height).toBe(260)
    const beforeGrowth = root.renderer.getScrollOffset(list.id)?.[1] ?? 0

    render(Array.from({ length: 30 }, (_, index) => `Streaming line ${index}`).join('\n'))
    await Bun.sleep(0)
    root.renderer.flush()
    const afterGrowth = root.renderer.getScrollOffset(list.id)?.[1] ?? 0
    expect(afterGrowth).toBeLessThanOrEqual(beforeGrowth)

    const surfaceBounds = await automation.getByTestId('transcript-scroll-surface').bounds()
    root.renderer.scrollTo(list.id, 0, -300)
    await automation.call('scrollWheel', { x: surfaceBounds.x + surfaceBounds.width / 2, y: surfaceBounds.y + 40, deltaX: 0, deltaY: 120 })
    root.renderer.flush()
    const userOffset = root.renderer.getScrollOffset(list.id)?.[1] ?? 0

    render(Array.from({ length: 60 }, (_, index) => `Streaming line ${index}`).join('\n'))
    await Bun.sleep(0)
    root.renderer.flush()
    expect(Math.abs((root.renderer.getScrollOffset(list.id)?.[1] ?? 0) - userOffset)).toBeLessThan(2)

    await automation.close()
    root.unmount()
  })

  it('keeps every work trace uniquely keyed and retained when a persisted suffix prepends', async () => {
    const tail: PiMessage[] = [
      { role: 'user', workbenchEntryId: 'tail-user', content: 'Tail prompt', timestamp: 100 },
      { role: 'assistant', workbenchEntryId: 'tail-thinking-a', content: [{ type: 'thinking', thinking: 'First tail trace' }], timestamp: 101 },
      { role: 'assistant', workbenchEntryId: 'tail-text', content: 'A stable separator', timestamp: 102 },
      { role: 'assistant', workbenchEntryId: 'tail-thinking-b', content: [{ type: 'thinking', thinking: 'Second tail trace' }], timestamp: 103 },
      ...Array.from({ length: 12 }, (_, index): PiMessage[] => [
        { role: 'user', workbenchEntryId: `later-user-${index}`, content: `Later prompt ${index}`, timestamp: 200 + index * 2 },
        { role: 'assistant', workbenchEntryId: `later-answer-${index}`, content: `Later answer ${index}`, timestamp: 201 + index * 2 },
      ]).flat(),
    ]
    const older: PiMessage[] = [
      { role: 'user', workbenchEntryId: 'older-user', content: 'Older prompt', timestamp: 1 },
      { role: 'assistant', workbenchEntryId: 'older-answer', content: 'Older answer', timestamp: 2 },
    ]
    const forkCatalog: PiForkMessage[] = [
      { entryId: 'older-user', text: 'Older prompt' },
      { entryId: 'tail-user', text: 'Tail prompt' },
      ...Array.from({ length: 12 }, (_, index) => ({ entryId: `later-user-${index}`, text: `Later prompt ${index}` })),
    ]
    const state = (traceMessages: PiMessage[]) => ({
      ...createInitialState('/tmp/unique-trace-project'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/unique-trace.jsonl', sessionId: 'unique-trace' },
      messages: traceMessages,
      messagesHasOlder: true,
      forkMessages: forkCatalog,
    })
    const root = createTestRoot({ width: 900, height: 500 })
    const automation = await connectTest(root.renderer)
    const errors: string[] = []
    const originalError = console.error
    console.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')) }
    const render = (traceMessages: PiMessage[]) => root.render(
      <div style={{ width: 900, height: 500, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state(traceMessages)} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )

    try {
      render(tail)
      const list = root.renderer.findByTestId('transcript-list')!
      root.renderer.scrollToItem(list.id, 1)
      const traceIds = (await automation.getByTestId('execution-trace').all()).map((node) => node.id)
      expect(traceIds).toHaveLength(2)

      render([...older, ...tail])
      root.renderer.flush()

      const retainedTraceIds = (await automation.getByTestId('execution-trace').all()).map((node) => node.id)
      expect(retainedTraceIds).toHaveLength(2)
      expect(retainedTraceIds).toEqual(traceIds)
      expect(root.renderer.findByTestId('transcript-list')?.id).toBe(list.id)
      expect(errors.filter((line) => line.includes('same key'))).toEqual([])
    } finally {
      console.error = originalError
      await automation.close()
      root.unmount()
    }
  })

  it('progressively projects a large trace as independent native rows', async () => {
    const calls = Array.from({ length: 256 }, (_, index) => ({ type: 'toolCall' as const, id: `window-call-${index}`, name: 'read', arguments: { path: `src/window-${index}.ts` } }))
    const traceMessages: PiMessage[] = [
      { role: 'user', workbenchEntryId: 'window-user', content: 'Inspect the large trace', timestamp: 1 },
      { role: 'assistant', workbenchEntryId: 'window-assistant', content: [{ type: 'thinking', thinking: 'Keep this trace virtual.' }, ...calls], timestamp: 2 },
      ...calls.map((call, index): PiMessage => ({ role: 'toolResult', workbenchEntryId: `window-result-${index}`, toolCallId: call.id, toolName: call.name, content: `result ${index}`, timestamp: 3 + index })),
    ]
    const state = {
      ...createInitialState('/tmp/windowed-trace-project'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/windowed-trace.jsonl', sessionId: 'windowed-trace' },
      messages: traceMessages,
    }
    const root = createTestRoot({ width: 1000, height: 700 })
    root.render(
      <div style={{ width: 1000, height: 700, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )
    const automation = await connectTest(root.renderer)
    const surface = await automation.getByTestId('transcript-scroll-surface').bounds()
    const headerBefore = await automation.getByTestId('tool-row').bounds()

    await automation.getByTestId('tool-row').press('enter')
    await Bun.sleep(0)
    root.renderer.flush()

    const list = root.renderer.findByTestId('transcript-list')!
    const headerAfter = await automation.getByTestId('tool-row').bounds()
    const mountedTools = await automation.getByTestId('tool-detail-row').count()
    expect(list.customProps?.itemCount).toBeUndefined()
    expect(list.children.length).toBeLessThan(128)
    expect(mountedTools).toBeGreaterThan(0)
    expect(mountedTools).toBeLessThan(128)
    expect(await automation.getByTestId('trace-projection-continuation').count()).toBe(1)
    expect(headerAfter.y).toBeGreaterThanOrEqual(surface.y)
    expect(headerAfter.y + headerAfter.height).toBeLessThanOrEqual(surface.y + surface.height)
    expect(headerAfter.y).toBeLessThanOrEqual(headerBefore.y)
    expect(root.renderer.getAllText().length).toBeLessThan(1_000)

    const wheelStarted = performance.now()
    for (let index = 0; index < 20; index += 1) {
      await automation.call('scrollWheel', { x: surface.x + surface.width / 2, y: surface.y + surface.height / 2, deltaX: 0, deltaY: index % 2 ? -120 : 120 })
      root.renderer.flush()
    }
    expect(performance.now() - wheelStarted).toBeLessThan(400)

    await Bun.sleep(140)
    root.renderer.flush()
    expect(await automation.getByTestId('tool-detail-row').count()).toBe(256)
    expect(await automation.getByTestId('trace-projection-continuation').count()).toBe(0)
    expect(root.renderer.getPaintedText().length).toBeLessThan(100)

    await automation.close()
    root.unmount()
  })

  it('keeps a 9,397-second failed trace neutral, collapsed, and keyed across a prepend', async () => {
    const calls = Array.from({ length: 256 }, (_, index) => ({ type: 'toolCall' as const, id: `call-${index}`, name: 'read', arguments: { path: `src/file-${index}.ts` } }))
    const tail: PiMessage[] = [
      { role: 'assistant', workbenchEntryId: 'tail-assistant', timestamp: 9_397_000, content: [{ type: 'thinking', thinking: 'Planning the boundary work.' }, ...calls] },
      ...calls.map((call, index): PiMessage => ({ role: 'toolResult', workbenchEntryId: `tail-result-${index}`, toolCallId: call.id, toolName: call.name, content: `result ${index}`, isError: index === calls.length - 1, timestamp: index === calls.length - 1 ? 9_397_000 : 200 + index })),
    ]
    const older: PiMessage[] = [
      { role: 'assistant', workbenchEntryId: 'older-assistant', timestamp: 0, content: [{ type: 'thinking', thinking: 'Earlier reasoning from the same contiguous run.' }, { type: 'toolCall', id: 'older-call', name: 'read', arguments: { path: 'src/older.ts' } }] },
      { role: 'toolResult', workbenchEntryId: 'older-result', toolCallId: 'older-call', toolName: 'read', content: 'older result', timestamp: 50 },
    ]
    const state = (traceMessages: PiMessage[]) => ({
      ...createInitialState('/tmp/failed-trace-project'),
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/failed-trace.jsonl', sessionId: 'failed-trace' },
      messages: traceMessages,
    })
    const root = createTestRoot({ width: 900, height: 640 })
    const render = (traceMessages: PiMessage[]) => root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state(traceMessages)} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} />
      </div>,
    )
    render(tail)
    const automation = await connectTest(root.renderer)
    const listId = root.renderer.findByTestId('transcript-list')!.id
    const traceId = root.renderer.findByTestId('execution-trace')!.id
    expect(await automation.getByTestId('execution-timeline').count()).toBe(0)
    expect(await automation.getByTestId('tool-detail-row').count()).toBe(0)
    expect(root.renderer.findByTestId('execution-trace-label')?.style.color).toBe(colors.textMuted)
    expect(root.renderer.getAllText().length).toBeLessThan(20)

    render([...older, ...tail])
    root.renderer.flush()

    expect(root.renderer.findByTestId('transcript-list')?.id).toBe(listId)
    expect(root.renderer.findByTestId('execution-trace')?.id).toBe(traceId)
    expect(await automation.getByTestId('execution-timeline').count()).toBe(0)
    expect(root.renderer.findByTestId('execution-trace-label')?.style.color).toBe(colors.textMuted)
    expect(root.renderer.getAllText()).toContain('Worked for 9397s')

    await automation.close()
    root.unmount()
  })

  it('nests compact Markdown reasoning, context injections, and Fabric calls inside one execution trace', async () => {
    const kernel = new WorkbenchKernel()
    kernel.mount(coreToolPresentersPlugin)
    const traceMessages: PiMessage[] = [
      { role: 'user', content: 'Inspect the execution trace', timestamp: 1 },
      { role: 'assistant', timestamp: 2, content: [
        { type: 'thinking', thinking: '# Plan\nUse **bold reasoning** without enlarging this heading.' },
        { type: 'toolCall', id: 'fabric', name: 'fabric_exec', arguments: { code: 'return await Promise.all(calls)', display: { name: 'Inspecting in parallel' } } },
      ] },
      { role: 'toolResult', toolCallId: 'fabric', toolName: 'fabric_exec', content: [{ type: 'text', text: 'ok: true' }], details: { audits: Array.from({ length: 10 }, (_, index) => ({ ref: `pi.read.${index}`, tool: 'read', provider: 'pi', success: true, args: { path: index === 0 ? `src/${'deeply-nested/'.repeat(16)}file-${index}.ts` : `src/file-${index}.ts` } })) }, timestamp: 3 },
      { role: 'custom', customType: 'pi-fovea-sync', display: true, content: 'Repository structure changed.\n**Changed:** src/file-9.ts', timestamp: 4 },
    ]
    const state = {
      ...createInitialState('/tmp/trace-project'),
      connection: 'connected' as const,
      session: { model: null, thinkingLevel: 'off' as const, isStreaming: false, sessionFile: '/tmp/trace.jsonl', sessionId: 'trace' },
      messages: traceMessages,
      forkMessages: [{ entryId: 'trace-entry', text: 'Inspect the execution trace' }],
    }
    const root = createTestRoot()
    let revertCalls = 0
    root.render(
      <div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}>
        <Transcript state={state} presenters={kernel.contributions(toolPresenterSlot)} onOpenDiff={() => {}} onRevert={() => { revertCalls += 1 }} />
      </div>,
    )
    const automation = await connectTest(root.renderer)
    try {
      expect(await automation.getByTestId('trace-reasoning').count()).toBe(0)
      await automation.getByTestId('tool-row').click()
      root.renderer.flush()

      expect(await automation.getByTestId('trace-reasoning').count()).toBe(1)
      expect(await automation.getByTestId('trace-context-injection').count()).toBe(1)
      expect(await automation.getByTestId('fabric-collapsed-call').count()).toBe(8)
      const statusNodes = await automation.getByTestId('fabric-collapsed-status').all()
      const statusXs = statusNodes.flatMap((node) => node.bounds ? [node.bounds.x] : [])
      expect(Math.max(...statusXs) - Math.min(...statusXs)).toBeLessThan(1)
      expect(root.renderer.getAllText()).toContain('Plan Use bold reasoning without enlarging this heading.')
      expect(root.renderer.getAllText()).toContain('CONTEXT INJECTION')
      expect(root.renderer.getAllText()).toContain('… 2 nested calls hidden')

      await automation.getByTestId('tool-detail-row').hover()
      await automation.getByTestId('copy-tool').click()
      expect(await automation.getByTestId('fabric-tool-body').count()).toBe(0)
      expect(await automation.getByTestId('fabric-collapsed-calls').count()).toBe(1)
      await automation.getByTestId('revert-tool').click()
      expect(revertCalls).toBe(1)
      expect(await automation.getByTestId('fabric-tool-body').count()).toBe(0)

      await automation.getByTestId('trace-reasoning-toggle').click()
      root.renderer.flush()
      const markdown = root.renderer.findByTestId('trace-reasoning-markdown')
      expect(markdown?.customProps?.source).toContain('# Plan')
      const metrics = (markdown?.customProps?.theme as { metrics?: { mdHeadingSizes?: number[]; mdHeadingLineHeights?: number[] } } | undefined)?.metrics
      expect(metrics?.mdHeadingSizes).toEqual([12, 12, 12, 12])
      expect(metrics?.mdHeadingLineHeights).toEqual([19, 19, 19, 19])

      await automation.getByTestId('tool-row').click()
      expect(await automation.getByTestId('trace-reasoning-markdown').count()).toBe(0)
      await automation.getByTestId('tool-row').click()
      expect(await automation.getByTestId('trace-reasoning-markdown').count()).toBe(1)
    } finally {
      await automation.close()
      root.unmount()
      await kernel.dispose()
    }
  })
})
