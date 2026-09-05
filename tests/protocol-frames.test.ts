import { describe, expect, it } from 'bun:test'
import { encodeFrames, FrameAssembler, isWireFrame, MAX_WS_FRAME_BYTES, splitUtf8, utf8ByteLength } from '../src/protocol/frames.ts'

describe('workspace wire frames', () => {
  it('leaves small payloads as a single JSON message', () => {
    const json = JSON.stringify({ kind: 'pong' })
    expect(encodeFrames(json)).toEqual([json])
  })

  it('splits a payload larger than the frame budget and round-trips through the assembler', () => {
    const json = JSON.stringify({ kind: 'welcome', snapshot: { editorText: 'x'.repeat(400_000) } })
    expect(utf8ByteLength(json)).toBeGreaterThan(MAX_WS_FRAME_BYTES)
    const frames = encodeFrames(json, 8_192)
    expect(frames.length).toBeGreaterThan(1)
    for (const frame of frames) {
      expect(utf8ByteLength(frame)).toBeLessThanOrEqual(8_192)
      expect(isWireFrame(JSON.parse(frame))).toBe(true)
    }
    const assembler = new FrameAssembler()
    let assembled: string | undefined
    for (const frame of frames) assembled = assembler.push(frame)
    expect(assembled).toBe(json)
  })

  it('rejects an assembled payload over the memory bound', () => {
    const assembler = new FrameAssembler()
    const first = JSON.stringify({ kind: 'frame', id: 'a', index: 0, count: 2, data: 'hello' })
    expect(assembler.push(first, 8)).toBeUndefined()
    expect(() => assembler.push(JSON.stringify({ kind: 'frame', id: 'a', index: 1, count: 2, data: 'world!!!' }), 8)).toThrow(/too large/)
  })

  it('splits UTF-8 on code-point boundaries', () => {
    const chunks = splitUtf8('ééé', 3)
    expect(chunks.join('')).toBe('ééé')
    expect(chunks.every((chunk) => utf8ByteLength(chunk) <= 3)).toBe(true)
  })

  it('keeps quote-heavy JSON frames under the byte budget', () => {
    const json = JSON.stringify({ kind: 'welcome', snapshot: { keys: Object.fromEntries(Array.from({ length: 8_000 }, (_, index) => [`k${index}`, `v${index}`])) } })
    const frames = encodeFrames(json, 8_192)
    expect(frames.length).toBeGreaterThan(1)
    for (const frame of frames) expect(utf8ByteLength(frame)).toBeLessThanOrEqual(8_192)
    const assembler = new FrameAssembler()
    let assembled: string | undefined
    for (const frame of frames) assembled = assembler.push(frame)
    expect(assembled).toBe(json)
  })
})
