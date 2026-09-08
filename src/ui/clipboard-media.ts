import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawn } from 'node:child_process'
import { Worker } from 'node:worker_threads'
import type { ComposerImage, PiContentBlock, PiMessage } from '../pi/types.ts'

const IMAGE_CACHE_DIRECTORY = join(tmpdir(), 'heddlework-images-v1')
const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024
const APPLE_FILE_SCRIPT = `set clipboardFile to the clipboard as alias
return POSIX path of clipboardFile
`
const APPLE_SCRIPT = `on run argv
  set targetPath to item 1 of argv
  set imageData to the clipboard as «class PNGf»
  set fileRef to open for access POSIX file targetPath with write permission
  try
    set eof fileRef to 0
    write imageData to fileRef
  on error errorMessage number errorNumber
    close access fileRef
    error errorMessage number errorNumber
  end try
  close access fileRef
  return targetPath
end run
`

export async function readClipboardImage(): Promise<ComposerImage | undefined> {
  try {
    if (process.platform === 'darwin') return await readMacClipboardImage()
    if (process.platform === 'win32') return await readWindowsClipboardImage()
    return await readLinuxClipboardImage()
  } catch {
    return undefined
  }
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false
  const input = Buffer.from(text, 'utf8')
  if (process.platform === 'darwin') return (await runProcess('/usr/bin/pbcopy', [], input)).ok
  if (process.platform === 'win32') return (await runProcess('clip.exe', [], input)).ok
  for (const [command, args] of [['wl-copy', []], ['xclip', ['-selection', 'clipboard']]] as const) {
    const result = await runProcess(command, [...args], input)
    if (result.ok) return true
  }
  return false
}

export function editorTextAfterImagePaste(previous: string, current: string): string {
  if (previous === current) return current
  let prefix = 0
  while (prefix < previous.length && previous[prefix] === current[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < previous.length - prefix
    && previous[previous.length - suffix - 1] === current[current.length - suffix - 1]
  ) suffix += 1
  const inserted = current.slice(prefix, current.length - suffix).trim().replace(/^['"]|['"]$/g, '')
  const normalized = inserted.toLowerCase()
  const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp'].some((extension) => normalized.endsWith(extension))
  const isPath = normalized.startsWith('file://') || normalized.includes('/') || normalized.includes('\\')
  return isImage && isPath ? previous : current
}

export function createComposerImage(bytes: Uint8Array, mimeType?: string, fileName?: string): ComposerImage {
  if (bytes.byteLength === 0) throw new Error('Clipboard image is empty')
  if (bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) throw new Error('Clipboard image exceeds 20 MB')
  const detectedMime = mimeType ?? sniffImageMime(bytes)
  if (!detectedMime) throw new Error('Clipboard does not contain a supported image')
  const extension = imageExtension(detectedMime)
  const id = `image-${randomUUID()}`
  const previewPath = writePreview(bytes, `${id}.${extension}`)
  return {
    id,
    type: 'image',
    data: Buffer.from(bytes).toString('base64'),
    mimeType: detectedMime,
    previewPath,
    fileName: fileName?.trim() || `Pasted image.${extension}`,
    size: bytes.byteLength,
  }
}

type HydrationCacheEntry = {
  source: PiMessage
  message: PiMessage
}

const HYDRATION_CACHE_LIMIT = 64
const hydrationCache = new Map<string, HydrationCacheEntry>()
let hydrationHashes = 0
let hydrationWrites = 0
let hydrationBackend: 'worker' | 'async' | 'idle' = 'idle'
let hydrationWorker: Worker | undefined
let hydrationRequestId = 0
const hydrationPending = new Map<number, { resolve(path: string | undefined): void }>()

export function imageHydrationWork(): { hashes: number; writes: number } {
  return { hashes: hydrationHashes, writes: hydrationWrites }
}

export function imageHydrationBackend(): 'worker' | 'async' | 'idle' {
  return hydrationBackend
}

export function resetImageHydrationCache(): void {
  hydrationCache.clear()
  hydrationHashes = 0
  hydrationWrites = 0
}

export function messageHydrationIdentity(message: PiMessage): string {
  return typeof message.workbenchEntryId === 'string' && message.workbenchEntryId ? message.workbenchEntryId : ''
}

function messageNeedsMaterialize(message: PiMessage): boolean {
  if (!Array.isArray(message.content)) return false
  return message.content.some((block) => (
    block.type === 'image'
    && typeof block.data === 'string'
    && block.data.length > 0
    && typeof block.mimeType === 'string'
    && !block.previewPath
  ))
}

function rememberHydrated(source: PiMessage, message: PiMessage): void {
  const identity = messageHydrationIdentity(source)
  if (!identity || source === message) return
  if (hydrationCache.has(identity)) hydrationCache.delete(identity)
  hydrationCache.set(identity, { source, message })
  while (hydrationCache.size > HYDRATION_CACHE_LIMIT) {
    const oldest = hydrationCache.keys().next().value
    if (oldest === undefined) break
    hydrationCache.delete(oldest)
  }
}

function shallowEqual(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const keys = Object.keys(left)
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]))
}

function cachedHydrated(source: PiMessage): PiMessage | undefined {
  const identity = messageHydrationIdentity(source)
  const cached = hydrationCache.get(identity)
  if (!cached) return undefined
  const before = cached.source.content
  const after = source.content
  if (before !== after && !(Array.isArray(before) && Array.isArray(after)
    && before.length === after.length && before.every((block, index) => shallowEqual(block, after[index]!)))) return undefined
  // Reuse prepared image bytes, never an old message's metadata or unrelated content.
  const message = shallowEqual({ ...cached.source, content: after }, source)
    ? cached.message : { ...source, content: cached.message.content! }
  rememberHydrated(source, message)
  return message
}

function materializeMessageImagesSync(message: PiMessage): PiMessage {
  if (!Array.isArray(message.content)) return message
  let changed = false
  const content = message.content.map((block) => {
    if (block.type !== 'image' || typeof block.data !== 'string' || typeof block.mimeType !== 'string' || block.previewPath) return block
    const previewPath = materializeImagePreview(block.data, block.mimeType)
    if (!previewPath) return block
    changed = true
    return { ...block, previewPath, data: '' }
  })
  return changed ? { ...message, content } : message
}

export function hydrateMessageImages(messages: PiMessage[], options?: { eager?: boolean }): PiMessage[] {
  if (options?.eager === false) return messages
  let changed = false
  const next = messages.map((message) => {
    const cached = cachedHydrated(message)
    if (cached) {
      if (cached !== message) changed = true
      return cached
    }
    if (!messageNeedsMaterialize(message)) return message
    const hydrated = materializeMessageImagesSync(message)
    rememberHydrated(message, hydrated)
    if (hydrated !== message) changed = true
    return hydrated
  })
  return changed ? next : messages
}

export async function prepareVisibleMessageImages(
  messages: PiMessage[],
  visibleIds: ReadonlySet<string>,
  options?: { signal?: AbortSignal },
): Promise<PiMessage[]> {
  const signal = options?.signal
  if (signal?.aborted) return messages
  let prepared = messages
  for (let index = 0; index < messages.length; index += 1) {
    if (signal?.aborted) return messages
    const message = messages[index]!
    const identity = messageHydrationIdentity(message)
    if (!identity || !visibleIds.has(identity)) continue
    const hydrated = cachedHydrated(message) ?? (messageNeedsMaterialize(message)
      ? await materializeMessageImagesAsync(message, signal) : message)
    if (signal?.aborted) return messages
    rememberHydrated(message, hydrated)
    if (hydrated !== message) {
      if (prepared === messages) prepared = messages.slice()
      prepared[index] = hydrated
    }
  }
  return prepared
}

async function materializeMessageImagesAsync(message: PiMessage, signal?: AbortSignal): Promise<PiMessage> {
  if (!Array.isArray(message.content)) return message
  let changed = false
  const content: PiContentBlock[] = []
  for (const block of message.content) {
    if (block.type !== 'image' || typeof block.data !== 'string' || typeof block.mimeType !== 'string' || block.previewPath) {
      content.push(block)
      continue
    }
    const previewPath = await materializeImagePreviewAsync(block.data, block.mimeType, signal)
    if (!previewPath) {
      content.push(block)
      continue
    }
    changed = true
    content.push({ ...block, previewPath, data: '' })
  }
  return changed ? { ...message, content } : message
}

async function materializeImagePreviewAsync(data: string, mimeType: string, signal?: AbortSignal): Promise<string | undefined> {
  if (signal?.aborted) return undefined
  ensureImageDirectory()
  const fromWorker = await materializeImagePreviewOnWorker(data, mimeType, signal)
  if (fromWorker !== undefined || signal?.aborted) return fromWorker
  hydrationBackend = hydrationBackend === 'worker' ? hydrationBackend : 'async'
  await Promise.resolve()
  if (signal?.aborted) return undefined
  const bytes = Buffer.from(data, 'base64')
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) return undefined
  const extension = imageExtension(mimeType)
  hydrationHashes += 1
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
  const path = join(IMAGE_CACHE_DIRECTORY, `${hash}.${extension}`)
  if (!existsSync(path) || statSync(path).size !== bytes.byteLength) {
    hydrationWrites += 1
    await writeFile(path, bytes)
  }
  return path
}

function imageHydrationWorkerEntry(): string | URL {
  // Bun compile embeds extra entrypoints under /$bunfs/root/<path-from-compile-cwd>.
  // `new URL(..., import.meta.url)` resolves against the compiled outfile instead.
  if (import.meta.path.startsWith('/$bunfs/') || import.meta.url.includes('/$bunfs/')) {
    return './src/ui/image-hydration-worker.ts'
  }
  return new URL('./image-hydration-worker.ts', import.meta.url)
}

function ensureHydrationWorker(): Worker | undefined {
  if (hydrationWorker) return hydrationWorker
  try {
    const worker = new Worker(imageHydrationWorkerEntry())
    worker.on('message', (message: { requestId: number; ok: boolean; path?: string }) => {
      const pending = hydrationPending.get(message.requestId)
      if (!pending) return
      hydrationPending.delete(message.requestId)
      pending.resolve(message.ok ? message.path : undefined)
    })
    worker.on('error', () => {
      hydrationWorker = undefined
      hydrationBackend = 'async'
      for (const pending of hydrationPending.values()) pending.resolve(undefined)
      hydrationPending.clear()
    })
    hydrationWorker = worker
    hydrationBackend = 'worker'
    return worker
  } catch {
    hydrationBackend = 'async'
    return undefined
  }
}

function materializeImagePreviewOnWorker(data: string, mimeType: string, signal?: AbortSignal): Promise<string | undefined> {
  const worker = ensureHydrationWorker()
  if (!worker) return Promise.resolve(undefined)
  const requestId = ++hydrationRequestId
  return new Promise((resolve) => {
    const finish = (path: string | undefined) => {
      signal?.removeEventListener('abort', onAbort)
      hydrationPending.delete(requestId)
      if (path) {
        hydrationHashes += 1
        hydrationWrites += 1
      }
      resolve(path)
    }
    const onAbort = () => finish(undefined)
    if (signal?.aborted) {
      resolve(undefined)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    hydrationPending.set(requestId, { resolve: finish })
    worker.postMessage({
      requestId,
      data,
      mimeType,
      directory: IMAGE_CACHE_DIRECTORY,
      maxBytes: MAX_CLIPBOARD_IMAGE_BYTES,
    })
  })
}

export function imageBlocks(message: PiMessage): Array<PiContentBlock & { type: 'image'; data: string; mimeType: string }> {
  if (!Array.isArray(message.content)) return []
  return message.content.filter((block): block is PiContentBlock & { type: 'image'; data: string; mimeType: string } => (
    block.type === 'image' && typeof block.data === 'string' && block.data.length > 0 && typeof block.mimeType === 'string'
  ))
}

export function messageImageSrc(image: { data?: string; mimeType?: string; previewPath?: string }): string | undefined {
  if (image.previewPath) return image.previewPath
  if (image.data && image.mimeType) return `data:${image.mimeType};base64,${image.data}`
  return undefined
}

function materializeImagePreview(data: string, mimeType: string): string | undefined {
  try {
    const bytes = Buffer.from(data, 'base64')
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) return undefined
    const extension = imageExtension(mimeType)
    hydrationHashes += 1
    const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 24)
    return writePreview(bytes, `${hash}.${extension}`)
  } catch {
    return undefined
  }
}

async function readMacClipboardImage(): Promise<ComposerImage | undefined> {
  ensureImageDirectory()
  const path = join(IMAGE_CACHE_DIRECTORY, `clipboard-${randomUUID()}.png`)
  const result = await runProcess('/usr/bin/osascript', ['-', path], Buffer.from(APPLE_SCRIPT))
  if (result.ok && existsSync(path)) {
    const bytes = readFileSync(path)
    rmSync(path, { force: true })
    if (bytes.byteLength > 0 && bytes.byteLength <= MAX_CLIPBOARD_IMAGE_BYTES) return createComposerImage(bytes, 'image/png')
  } else {
    rmSync(path, { force: true })
  }

  const fileResult = await runProcess('/usr/bin/osascript', ['-e', APPLE_FILE_SCRIPT])
  if (!fileResult.ok) return undefined
  const filePath = fileResult.stdout.toString('utf8').trim()
  if (!filePath || !existsSync(filePath) || !statSync(filePath).isFile()) return undefined
  return createComposerImage(readFileSync(filePath), undefined, basename(filePath))
}

async function readLinuxClipboardImage(): Promise<ComposerImage | undefined> {
  const attempts: Array<[string, string[], string]> = [
    ['wl-paste', ['--no-newline', '--type', 'image/png'], 'image/png'],
    ['wl-paste', ['--no-newline', '--type', 'image/jpeg'], 'image/jpeg'],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o'], 'image/png'],
    ['xclip', ['-selection', 'clipboard', '-t', 'image/jpeg', '-o'], 'image/jpeg'],
  ]
  for (const [command, args, mimeType] of attempts) {
    const result = await runProcess(command, args)
    if (result.ok && result.stdout.byteLength > 0) return createComposerImage(result.stdout, mimeType)
  }
  return undefined
}

async function readWindowsClipboardImage(): Promise<ComposerImage | undefined> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    '$image = [Windows.Forms.Clipboard]::GetImage()',
    'if ($null -eq $image) { exit 2 }',
    '$stream = New-Object IO.MemoryStream',
    '$image.Save($stream, [Drawing.Imaging.ImageFormat]::Png)',
    '[Convert]::ToBase64String($stream.ToArray())',
  ].join('; ')
  const result = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  if (!result.ok) return undefined
  const encoded = result.stdout.toString('utf8').trim()
  return encoded ? createComposerImage(Buffer.from(encoded, 'base64'), 'image/png') : undefined
}

function sniffImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 8 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && Buffer.from(bytes.subarray(0, 6)).toString('ascii').startsWith('GIF8')) return 'image/gif'
  if (bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  return undefined
}

function imageExtension(mimeType: string): string {
  if (mimeType === 'image/jpeg') return 'jpg'
  if (mimeType === 'image/gif') return 'gif'
  if (mimeType === 'image/webp') return 'webp'
  return 'png'
}

function writePreview(bytes: Uint8Array, fileName: string): string {
  ensureImageDirectory()
  const path = join(IMAGE_CACHE_DIRECTORY, fileName)
  if (!existsSync(path) || statSync(path).size !== bytes.byteLength) {
    hydrationWrites += 1
    writeFileSync(path, bytes)
  }
  return path
}

function ensureImageDirectory(): void {
  mkdirSync(IMAGE_CACHE_DIRECTORY, { recursive: true })
}

async function runProcess(command: string, args: string[], input?: Uint8Array): Promise<{ ok: boolean; stdout: Buffer }> {
  return await new Promise((resolve) => {
    let settled = false
    const finish = (value: { ok: boolean; stdout: Buffer }) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let child
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      finish({ ok: false, stdout: Buffer.alloc(0) })
      return
    }
    const chunks: Buffer[] = []
    child.stdout.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => finish({ ok: false, stdout: Buffer.alloc(0) }))
    child.on('close', (code) => finish({ ok: code === 0, stdout: Buffer.concat(chunks) }))
    if (input) child.stdin.end(input)
    else child.stdin.end()
  })
}
