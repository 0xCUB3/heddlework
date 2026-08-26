import { describe, expect, it } from 'bun:test'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { createComposerImage, editorTextAfterImagePaste, hydrateMessageImages } from '../src/ui/clipboard-media.ts'

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
    if (Array.isArray(content)) expect(content[1]?.previewPath).toBeTruthy()
  })
})
