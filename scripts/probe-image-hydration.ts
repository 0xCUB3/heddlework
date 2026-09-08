import { readFileSync } from 'node:fs'
import {
  imageHydrationBackend,
  prepareVisibleMessageImages,
  resetImageHydrationCache,
} from '../src/ui/clipboard-media.ts'
import type { PiMessage } from '../src/pi/types.ts'

// 1×1 PNG. Embedded so the compiled probe does not read fixtures from the source tree.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

resetImageHydrationCache()
const message: PiMessage = {
  role: 'user',
  workbenchEntryId: 'probe-visible',
  content: [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }],
}
const prepared = await prepareVisibleMessageImages([message], new Set(['probe-visible']))
const block = Array.isArray(prepared[0]?.content) ? prepared[0].content[0] : undefined
const previewPath = block && typeof block === 'object' && 'previewPath' in block && typeof block.previewPath === 'string'
  ? block.previewPath
  : undefined
const bytes = previewPath ? readFileSync(previewPath) : Buffer.alloc(0)
const result = {
  backend: imageHydrationBackend(),
  bytesEqual: bytes.equals(PNG),
  size: bytes.byteLength,
  compiled: import.meta.path.startsWith('/$bunfs/'),
}
console.log(JSON.stringify(result))
process.exit(result.backend === 'worker' && result.bytesEqual && result.compiled && result.size === PNG.byteLength ? 0 : 1)
