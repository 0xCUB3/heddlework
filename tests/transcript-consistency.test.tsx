import React from 'react'
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { PiMessage } from '../src/pi/types.ts'
import { Transcript } from '../src/ui/transcript.tsx'
import { transcriptProjectionRowsEqual, type TranscriptProjectionRow } from '../src/ui/transcript-projection.ts'
import { hydrateMessageImages, prepareVisibleMessageImages, resetImageHydrationCache } from '../src/ui/clipboard-media.ts'
import { createInitialState, type WorkbenchState } from '../src/workbench/state.ts'

const noop = () => undefined
const presenters = new Map()
const png = readFileSync(`${import.meta.dir}/fixtures/pasted-image.png`).toString('base64')
const imageMessage = (id: string): PiMessage => ({ role: 'user', workbenchEntryId: id, content: [{ type: 'image', data: png, mimeType: 'image/png' }] })
const row = (item: Extract<TranscriptProjectionRow, { kind: 'timeline-item' }>['item']): TranscriptProjectionRow => ({ id: item.id, kind: 'timeline-item', item })

describe('transcript cache consistency', () => {
  it('invalidates image previews and usage-only changes without changing row ids', () => {
    const user = { id: 'user', kind: 'user' as const, text: 'Image', images: [{ type: 'image' as const, data: png, mimeType: 'image/png' }] }
    expect(transcriptProjectionRowsEqual(row(user), row({ ...user, images: [{ ...user.images[0]!, data: '', previewPath: '/tmp/prepared.png' }] }))).toBe(false)
    const assistant = { id: 'answer', kind: 'assistant' as const, text: 'Done', metrics: 'out 1' }
    expect(transcriptProjectionRowsEqual(row(assistant), row({ ...assistant, metrics: 'out 2' }))).toBe(false)
  })

  it('never substitutes stale cached content for a different message with the same entry id', () => {
    resetImageHydrationCache()
    const original = imageMessage('same-id')
    hydrateMessageImages([original])
    const replacement: PiMessage = { role: 'user', workbenchEntryId: 'same-id', content: 'Replacement without an image' }
    expect(hydrateMessageImages([replacement])[0]).toBe(replacement)
    const edited = { ...original, timestamp: 1234 }
    expect(hydrateMessageImages([edited])[0]?.timestamp).toBe(1234)
  })

  it('adopts both cached and uncached visible images in one batch', async () => {
    resetImageHydrationCache()
    const warm = imageMessage('warm')
    const cold = imageMessage('cold')
    hydrateMessageImages([warm])
    const prepared = await prepareVisibleMessageImages([warm, cold], new Set(['warm', 'cold']))
    for (const message of prepared) {
      expect(Array.isArray(message.content) && message.content[0]?.previewPath).toBeTruthy()
    }
  })
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip
describeNative('native transcript state consistency', () => {
  it('does not steal a historical reading position when a new stream starts', async () => {
    const root = createTestRoot({ width: 900, height: 640 })
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: 'user', workbenchEntryId: `reading-${i}`, content: `Prompt ${i}` }))
    const base = createInitialState('/tmp/reading-stream')
    const render = (streaming: boolean) => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={{ ...base, messages, session: { ...base.session, isStreaming: streaming }, ...(streaming ? { liveAssistant: { id: 'new-stream', blocks: [{ index: 0, kind: 'text' as const, text: 'Streaming' }] } } : {}) }} presenters={presenters} onOpenDiff={noop} onRevert={noop} /></div>)
    try {
      render(false)
      const list = root.renderer.findByTestId('transcript-list')!
      root.renderer.scrollToItem(list.id, 20)
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, 120)
      const before = root.renderer.getListScrollTop(list.id)
      render(true)
      await Bun.sleep(30)
      root.renderer.flush()
      expect(root.renderer.findByTestId('transcript-list')?.customProps?.followTail).toBe(false)
      expect(root.renderer.getListScrollTop(list.id)).toEqual(before)
    } finally { root.unmount() }
  })

  it('unpins on tiny upward movement, and resumes only after returning to the bottom', () => {
    const root = createTestRoot({ width: 900, height: 640 })
    const base = createInitialState('/tmp/precision-follow')
    const state = { ...base, session: { ...base.session, isStreaming: true }, messages: Array.from({ length: 40 }, (_, i) => ({ role: 'user', workbenchEntryId: `precision-${i}`, content: `Prompt ${i}` })) }
    try {
      root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={presenters} onOpenDiff={noop} onRevert={noop} /></div>)
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, -120)
      expect(root.renderer.findByTestId('transcript-list')?.customProps?.followTail).toBe(true)
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, 0.5)
      expect(root.renderer.findByTestId('transcript-list')?.customProps?.followTail).toBe(false)
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, 1200)
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, -120)
      expect(root.renderer.findByTestId('transcript-list')?.customProps?.followTail).toBe(false)
      root.renderer.nativeSimulateScrollWheel(450, 300, 0, -100_000)
      expect(root.renderer.findByTestId('transcript-list')?.customProps?.followTail).toBe(true)
    } finally { root.unmount() }
  })

  it('keeps the history request lock when messages update or an older session request completes', async () => {
    const root = createTestRoot({ width: 900, height: 640 })
    const loads: string[] = []
    const pending = new Map<string, () => void>()
    const render = (session: string, count: number) => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript
      state={{ ...createInitialState(`/tmp/paging-${session}`), messagesHasOlder: true, messages: Array.from({ length: count }, (_, i) => ({ role: 'user', workbenchEntryId: `${session}-${i}`, content: 'Prompt' })) }}
      presenters={presenters} onOpenDiff={noop} onRevert={noop}
      onLoadEarlier={() => { loads.push(session); return new Promise<void>((resolve) => pending.set(session, resolve)) }}
    /></div>)
    const up = () => root.renderer.nativeSimulateScrollWheel(450, 300, 0, 120)
    try {
      render('a', 1)
      up()
      expect(loads).toEqual(['a'])
      render('a', 2)
      up()
      expect(loads).toEqual(['a'])
      render('b', 1)
      up()
      expect(loads).toEqual(['a', 'b'])
      pending.get('a')?.()
      await Bun.sleep(0)
      up()
      expect(loads).toEqual(['a', 'b'])
    } finally {
      root.unmount()
      for (const resolve of pending.values()) resolve()
    }
  })

  it('does not retry successful automatic detail requests on every render', async () => {
    const root = createTestRoot({ width: 900, height: 640 })
    let loads = 0
    const base = { ...createInitialState('/tmp/detail-once'), messages: [{ role: 'assistant', workbenchEntryId: 'once', content: 'Preview', detailRef: { entryId: 'once', bytes: 1000, omitted: true } }] }
    const loader = async () => { loads++ }
    try {
      for (let i = 0; i < 3; i++) {
        root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={{ ...base, activity: `pass-${i}` }} presenters={presenters} onOpenDiff={noop} onRevert={noop} onLoadDetail={loader} /></div>)
        await Bun.sleep(30)
        root.renderer.flush()
      }
      expect(loads).toBe(1)
    } finally { root.unmount() }
  })

  it('uses a callback-only replacement without depending on an unrelated state update', () => {
    const root = createTestRoot({ width: 900, height: 640 })
    const state = { ...createInitialState('/tmp/callback-consistency'), messages: [{ role: 'user', workbenchEntryId: 'revert-target', content: 'Prompt' }] }
    const calls: string[] = []
    const render = (label: string) => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={presenters} onOpenDiff={noop} onRevert={() => calls.push(label)} /></div>)
    try {
      render('old')
      render('new')
      const action = root.renderer.findByTestId('tree-message')!
      const bounds = root.renderer.getElementBounds(action.id)!
      root.renderer.nativeSimulateClick(bounds[0]! + 8, bounds[1]! + 8)
      expect(calls).toEqual(['new'])
    } finally { root.unmount() }
  })

  it('retains the same native list and reading position across appearance changes', () => {
    const root = createTestRoot({ width: 900, height: 640 })
    const state = { ...createInitialState('/tmp/theme-anchor'), messages: Array.from({ length: 60 }, (_, index) => ({ role: 'user', workbenchEntryId: `theme-${index}`, content: `Prompt ${index}` })) }
    const render = (appearance: 'dark' | 'light') => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={presenters} appearance={appearance} onOpenDiff={noop} onRevert={noop} /></div>)
    try {
      render('dark')
      const list = root.renderer.findByTestId('transcript-list')!
      root.renderer.scrollToItem(list.id, 20)
      const before = root.renderer.getListScrollTop(list.id)
      render('light')
      expect(root.renderer.findByTestId('transcript-list')?.id).toBe(list.id)
      expect(root.renderer.getListScrollTop(list.id)).toEqual(before)
    } finally { root.unmount() }
  })

  it('updates giant-message metadata even when the text is unchanged', () => {
    const root = createTestRoot({ width: 900, height: 640 })
    const text = Array.from({ length: 50 }, (_, index) => `Paragraph ${index} ${'word '.repeat(50)}`).join('\n\n')
    const base = createInitialState('/tmp/giant-metadata')
    const render = (output: number) => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={{ ...base, messages: [{ role: 'assistant', workbenchEntryId: 'giant-metadata', content: text, usage: { output } }] }} presenters={presenters} onOpenDiff={noop} onRevert={noop} /></div>)
    try {
      render(1)
      expect(root.renderer.getAllText().join('\n')).toContain('out 1')
      render(2)
      expect(root.renderer.getAllText().join('\n')).toContain('out 2')
    } finally { root.unmount() }
  })

  it('adopts asynchronously prepared images after the message array changes', async () => {
    resetImageHydrationCache()
    const root = createTestRoot({ width: 900, height: 640 })
    const base = createInitialState('/tmp/async-image')
    const render = (messages: PiMessage[]) => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={{ ...base, messages }} presenters={presenters} onOpenDiff={noop} onRevert={noop} /></div>)
    try {
      render([{ role: 'user', workbenchEntryId: 'initial', content: 'First' }])
      render([imageMessage('later-image')])
      for (let attempt = 0; attempt < 40; attempt++) {
        await Bun.sleep(10)
        root.renderer.flush()
        const src = root.renderer.findByType('img')[0]?.customProps?.src
        if (typeof src === 'string' && !src.startsWith('data:')) break
      }
      const src = root.renderer.findByType('img')[0]?.customProps?.src
      expect(typeof src).toBe('string')
      expect(String(src).startsWith('data:')).toBe(false)
    } finally { root.unmount() }
  })

  it('does not exceed the detail concurrency limit when visible rows change', async () => {
    const root = createTestRoot({ width: 900, height: 640 })
    let running = 0
    let peak = 0
    const finish: Array<() => void> = []
    const loader = async () => {
      peak = Math.max(peak, ++running)
      await new Promise<void>((resolve) => finish.push(resolve))
      running--
    }
    const base: WorkbenchState = { ...createInitialState('/tmp/detail-concurrency'), messages: Array.from({ length: 8 }, (_, index) => ({ role: 'assistant', workbenchEntryId: `detail-${index}`, content: `Preview ${index}`, detailRef: { entryId: `detail-${index}`, bytes: 1000, omitted: true } })) }
    const render = (activity: string) => root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={{ ...base, activity }} presenters={presenters} onOpenDiff={noop} onRevert={noop} onLoadDetail={loader} /></div>)
    try {
      for (let index = 0; index < 4; index++) {
        render(`working ${index}`)
        await Bun.sleep(30)
        root.renderer.flush()
      }
      expect(peak).toBeLessThanOrEqual(2)
      expect(peak).toBeGreaterThan(0)
    } finally {
      root.unmount()
      for (const resolve of finish) resolve()
    }
  })
})
