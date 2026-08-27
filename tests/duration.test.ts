import { describe, expect, it } from 'bun:test'
import { formatElapsedSeconds } from '../src/ui/duration.ts'

describe('formatElapsedSeconds', () => {
  it('uses compact seconds and minutes at their exact boundaries', () => {
    expect(formatElapsedSeconds(0)).toBe('1s')
    expect(formatElapsedSeconds(59)).toBe('59s')
    expect(formatElapsedSeconds(60)).toBe('1m')
    expect(formatElapsedSeconds(61)).toBe('1m 1s')
    expect(formatElapsedSeconds(3_599)).toBe('59m 59s')
  })

  it('normalizes long work into hours and days without noisy lower units', () => {
    expect(formatElapsedSeconds(3_600)).toBe('1h')
    expect(formatElapsedSeconds(9_397)).toBe('2h 36m')
    expect(formatElapsedSeconds(86_399)).toBe('23h 59m')
    expect(formatElapsedSeconds(86_400)).toBe('1d')
    expect(formatElapsedSeconds(183_600)).toBe('2d 3h')
  })
})
