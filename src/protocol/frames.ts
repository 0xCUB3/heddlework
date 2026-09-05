// Transport frames keep a single WebSocket message under the iOS URLSession default of 1 MiB.
export const MAX_WS_FRAME_BYTES = 256 * 1024
export const MAX_ASSEMBLED_BYTES = 32 * 1024 * 1024
const FRAME_OVERHEAD_BUDGET = 192

export interface WireFrame {
  kind: 'frame'
  id: string
  index: number
  count: number
  data: string
}

export function isWireFrame(value: unknown): value is WireFrame {
  if (!value || typeof value !== 'object') return false
  const frame = value as { kind?: unknown; id?: unknown; index?: unknown; count?: unknown; data?: unknown }
  return frame.kind === 'frame'
    && typeof frame.id === 'string'
    && frame.id.length > 0
    && typeof frame.index === 'number'
    && Number.isInteger(frame.index)
    && typeof frame.count === 'number'
    && Number.isInteger(frame.count)
    && typeof frame.data === 'string'
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

export function splitUtf8(text: string, maxBytes: number): string[] {
  if (maxBytes < 1) throw new Error('Frame payload budget must be positive')
  const bytes = new TextEncoder().encode(text)
  if (bytes.length <= maxBytes) return [text]
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let offset = 0
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length)
    while (end > offset && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
    if (end === offset) end = Math.min(offset + maxBytes, bytes.length)
    chunks.push(decoder.decode(bytes.subarray(offset, end)))
    offset = end
  }
  return chunks
}

export function encodeFrames(json: string, maxFrameBytes = MAX_WS_FRAME_BYTES): string[] {
  if (utf8ByteLength(json) <= maxFrameBytes) return [json]
  const id = crypto.randomUUID()
  let budget = Math.max(512, maxFrameBytes - FRAME_OVERHEAD_BUDGET)
  while (budget >= 512) {
    const parts = splitUtf8(json, budget)
    const frames = parts.map((data, index) => JSON.stringify({ kind: 'frame', id, index, count: parts.length, data } satisfies WireFrame))
    const overflow = frames.reduce((max, frame) => Math.max(max, utf8ByteLength(frame)), 0) - maxFrameBytes
    if (overflow <= 0) return frames
    budget = Math.max(512, budget - Math.max(256, overflow + 64))
  }
  throw new Error('Could not fit workspace snapshot into bounded frames')
}

export class FrameAssembler {
  #pending = new Map<string, { count: number; parts: Array<string | undefined>; received: number; bytes: number }>()

  reset(): void {
    this.#pending.clear()
  }

  // Returns the original payload, a completed frame payload, or undefined while more frames are required.
  push(raw: string, maxAssembledBytes = MAX_ASSEMBLED_BYTES): string | undefined {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return raw
    }
    if (!isWireFrame(parsed)) {
      if (this.#pending.size > 0) throw new Error('Workspace stream was interrupted by a non-frame message')
      return raw
    }
    if (parsed.count < 1 || parsed.index < 0 || parsed.index >= parsed.count) {
      throw new Error(`Invalid workspace frame ${parsed.index}/${parsed.count}`)
    }
    let entry = this.#pending.get(parsed.id)
    if (!entry) {
      entry = { count: parsed.count, parts: Array.from({ length: parsed.count }), received: 0, bytes: 0 }
      this.#pending.set(parsed.id, entry)
    } else if (entry.count !== parsed.count) {
      throw new Error('Workspace frame count changed mid-stream')
    }
    if (entry.parts[parsed.index] !== undefined) throw new Error(`Duplicate workspace frame ${parsed.index}`)
    const added = utf8ByteLength(parsed.data)
    if (entry.bytes + added > maxAssembledBytes) throw new Error(`Workspace snapshot is too large to open (${entry.bytes + added} bytes)`)
    entry.parts[parsed.index] = parsed.data
    entry.received += 1
    entry.bytes += added
    if (entry.received < entry.count) return undefined
    this.#pending.delete(parsed.id)
    return entry.parts.join('')
  }
}
