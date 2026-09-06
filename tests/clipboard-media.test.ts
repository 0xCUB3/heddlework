import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createComposerImage, editorTextAfterImagePaste, hydrateMessageImages, messageImageSrc } from '../src/ui/clipboard-media.ts'

const PNG = readFileSync(resolve(import.meta.dir, 'fixtures/pasted-image.png'))

describe('clipboard media', () => {
  it('removes a native pasted image path only after thumbnail ingestion', () => {
    expect(editorTextAfterImagePaste('Explain ', 'Explain /tmp/screenshot.png')).toBe('Explain ')
    expect(editorTextAfterImagePaste('before after', 'before file:///tmp/screenshot.webp after')).toBe('before after')
    expect(editorTextAfterImagePaste('Explain ', 'Explain ordinary pasted text')).toBe('Explain ordinary pasted text')
  })

  it('creates Pi-compatible image blocks and materializes persisted previews', () => {
    const image = createComposerImage(PNG, 'image/png')
    expect(image).toMatchObject({ type: 'image', mimeType: 'image/png', size: PNG.length })
    expect(existsSync(image.previewPath!)).toBe(true)
    expect(statSync(image.previewPath!).size).toBe(PNG.length)

    const messages = hydrateMessageImages([{
      role: 'user',
      content: [{ type: 'text', text: 'Look' }, { type: 'image', data: image.data, mimeType: image.mimeType }],
    }])
    const content = messages[0]!.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      const image = content[1]
      const previewPath = typeof image?.previewPath === 'string' ? image.previewPath : undefined
      expect(previewPath).toBeTruthy()
      expect(image?.data).toBe('')
      expect(messageImageSrc(previewPath ? { previewPath } : {})).toBe(previewPath)
    }
  })

  it('keeps a data URL fallback when hydrate cannot materialize a preview', () => {
    const messages = hydrateMessageImages([{
      role: 'user',
      content: [{ type: 'text', text: 'Look' }, { type: 'image', data: '', mimeType: 'image/png' }],
    }])
    const content = messages[0]!.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content[1]?.data).toBe('')
      expect(content[1]?.previewPath).toBeUndefined()
    }
    expect(messageImageSrc({ data: PNG.toString('base64'), mimeType: 'image/png' })).toMatch(/^data:image\/png;base64,/)
    expect(messageImageSrc({ mimeType: 'image/png' })).toBeUndefined()
  })
})
