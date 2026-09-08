import { createHash } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parentPort } from 'node:worker_threads'

type HydrationRequest = {
  requestId: number
  data: string
  mimeType: string
  directory: string
  maxBytes: number
}

parentPort?.on('message', (message: HydrationRequest) => {
  void (async () => {
    try {
      const bytes = Buffer.from(message.data, 'base64')
      if (bytes.byteLength === 0 || bytes.byteLength > message.maxBytes) {
        parentPort?.postMessage({ requestId: message.requestId, ok: false as const })
        return
      }
      const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
      const extension = message.mimeType === 'image/jpeg'
        ? 'jpg'
        : message.mimeType === 'image/gif'
          ? 'gif'
          : message.mimeType === 'image/webp'
            ? 'webp'
            : 'png'
      const path = join(message.directory, `${hash}.${extension}`)
      await writeFile(path, bytes)
      parentPort?.postMessage({ requestId: message.requestId, ok: true as const, path, hash })
    } catch (error) {
      parentPort?.postMessage({ requestId: message.requestId, ok: false as const, error: String(error) })
    }
  })()
})
