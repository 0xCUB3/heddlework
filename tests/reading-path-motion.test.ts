import { describe, expect, it } from 'bun:test'
import { LAYOUT_MOTION_TRANSITION, READING_LAYOUT_TRANSITION } from '../src/ui/motion.ts'

describe('reading-path motion', () => {
  it('does not animate layout height on the critical reading path', () => {
    expect(READING_LAYOUT_TRANSITION.duration).toBe(0)
    expect(LAYOUT_MOTION_TRANSITION.duration).toBeGreaterThan(0)
  })
})
