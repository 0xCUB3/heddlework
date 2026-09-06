import { describe, expect, it } from 'bun:test'
import { ansiRuns, readableAnsiColor } from '../src/ui/ansi-text.tsx'

describe('ANSI extension text', () => {
  it('preserves semantic colors and resets without retaining control bytes', () => {
    expect(ansiRuns('plain \x1b[1;31mfailed\x1b[0m done')).toEqual([{ text: 'plain ' }, { text: 'failed', color: 1, bold: true }, { text: ' done' }])
    expect(ansiRuns('\x1b[38;2;120;80;200mstatus\x1b[39m!')).toEqual([{ text: 'status', color: '#7850c8' }, { text: '!' }])
    expect(ansiRuns('\x1b[38;5;196mred')).toEqual([{ text: 'red', color: '#ff0000' }])
  })
  it('strips OSC hyperlinks and cursor controls rather than executing them', () => {
    expect(ansiRuns('\x1b]8;;https://example.com\x07link\x1b]8;;\x07\x1b[2J')).toEqual([{ text: 'link' }])
    expect(ansiRuns('a\nb')).toEqual([{ text: 'a\nb' }])
  })
  it('bounds both styled runs and text size', () => {
    expect(ansiRuns('\x1b[31ma'.repeat(10000)).length).toBeLessThanOrEqual(257)
    expect(ansiRuns('x'.repeat(50000))[0]?.text.length).toBe(24000)
  })
  it('adjusts true color for light and dark backgrounds', () => {
    expect(readableAnsiColor('#ffffff', '#ffffff')).not.toBe('#ffffff')
    expect(readableAnsiColor('#000000', '#000000')).not.toBe('#000000')
    expect(readableAnsiColor('#000000', '#ffffff')).toBe('#000000')
  })
})
