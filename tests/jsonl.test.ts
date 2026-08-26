import { describe, expect, it } from 'bun:test'
import { JsonlDecoder, serializeJsonLine } from '../src/pi/jsonl.ts'

describe('strict JSONL framing', () => {
  it('splits only on LF and preserves Unicode separators', () => {
    const decoder = new JsonlDecoder()
    const payload = { text: 'first\u2028second\u2029third' }
    expect(decoder.push(serializeJsonLine(payload))).toEqual([JSON.stringify(payload)])
  })

  it('handles UTF-8 characters split across chunks', () => {
    const decoder = new JsonlDecoder()
    const bytes = Buffer.from('{"text":"🙂"}\n')
    expect(decoder.push(bytes.subarray(0, 11))).toEqual([])
    expect(decoder.push(bytes.subarray(11))).toEqual(['{"text":"🙂"}'])
  })

  it('strips CR from CRLF and flushes a final record', () => {
    const decoder = new JsonlDecoder()
    expect(decoder.push('one\r\ntwo')).toEqual(['one'])
    expect(decoder.finish()).toEqual(['two'])
  })
})
