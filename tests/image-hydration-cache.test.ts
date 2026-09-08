import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  hydrateMessageImages,
  imageHydrationBackend,
  imageHydrationWork,
  prepareVisibleMessageImages,
  resetImageHydrationCache,
} from '../src/ui/clipboard-media.ts'
import type { PiMessage } from '../src/pi/types.ts'

const PNG = readFileSync(resolve(import.meta.dir, 'fixtures/pasted-image.png'))
const pngData = PNG.toString('base64')

function imageMessage(id: string, data = pngData): PiMessage {
  return {
    role: 'user',
    workbenchEntryId: id,
    content: [{ type: 'image', data, mimeType: 'image/png' }],
  }
}

function imageBlock(message: PiMessage) {
  const content = message.content
  if (!Array.isArray(content)) throw new Error('expected blocks')
  return content[0] as { data?: string; previewPath?: string }
}

describe('image hydration cache', () => {
  it('reuses object identity and skips hash/write on repeated hydration', () => {
    resetImageHydrationCache()
    const message = imageMessage('repeat-1')
    const first = hydrateMessageImages([message])
    const work = imageHydrationWork()
    expect(work.hashes).toBe(1)
    expect(work.writes).toBeGreaterThanOrEqual(0)
    expect(imageBlock(first[0]!).previewPath).toBeTruthy()
    expect(imageBlock(first[0]!).data).toBe('')

    const second = hydrateMessageImages([{ ...message }])
    expect(second[0]).toBe(first[0])
    expect(imageHydrationWork()).toEqual(work)
  })

  it('does not signature or materialize hidden images when eager is false', () => {
    resetImageHydrationCache()
    const hidden = imageMessage('hidden-image')
    const shown = imageMessage('shown-image')
    const source = [hidden, shown]
    const adopted = hydrateMessageImages(source, { eager: false })
    expect(adopted).toBe(source)
    expect(imageBlock(adopted[0]!).previewPath).toBeUndefined()
    expect(imageHydrationWork()).toEqual({ hashes: 0, writes: 0 })
  })

  it('materializes only exact visible IDs and leaves similarly prefixed hidden images untouched', async () => {
    resetImageHydrationCache()
    const hidden = imageMessage('user-10')
    const shown = imageMessage('user-1')
    const adopted = hydrateMessageImages([hidden, shown], { eager: false })
    const before = imageHydrationWork()
    const pending = prepareVisibleMessageImages(adopted, new Set(['user-1']))
    expect(imageHydrationWork()).toEqual(before)
    const prepared = await pending
    expect(imageBlock(prepared[0]!).previewPath).toBeUndefined()
    expect(imageBlock(prepared[0]!).data).toBe(pngData)
    expect(imageBlock(prepared[1]!).previewPath).toBeTruthy()
    expect(imageBlock(prepared[1]!).data).toBe('')
    expect(imageHydrationBackend()).toBe('worker')
    expect(imageHydrationWork().hashes).toBe(1)
    expect(prepared[0]).toBe(hidden)
  })

  it('cancels in-flight work on abort and does not process hidden images in a large fixture', async () => {
    resetImageHydrationCache()
    const hidden = Array.from({ length: 24 }, (_, index) => imageMessage(`hidden-${index}`, pngData))
    const shown = imageMessage('visible-large')
    const adopted = hydrateMessageImages([...hidden, shown], { eager: false })
    const controller = new AbortController()
    controller.abort()
    const cancelled = await prepareVisibleMessageImages(adopted, new Set(['visible-large']), { signal: controller.signal })
    expect(cancelled).toBe(adopted)
    expect(imageHydrationWork()).toEqual({ hashes: 0, writes: 0 })

    const prepared = await prepareVisibleMessageImages(adopted, new Set(['visible-large']))
    expect(imageBlock(prepared[prepared.length - 1]!).previewPath).toBeTruthy()
    expect(imageBlock(prepared[0]!).previewPath).toBeUndefined()
    expect(imageHydrationBackend()).toBe('worker')
    expect(imageHydrationWork().hashes).toBe(1)
  })
})
