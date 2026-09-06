import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { PiMessage } from '../src/pi/types.ts'
import { Transcript } from '../src/ui/transcript.tsx'
import { TRANSCRIPT_VIRTUAL_WINDOW_SIZE } from '../src/ui/virtual-window.ts'
import { createInitialState } from '../src/workbench/state.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

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
})
