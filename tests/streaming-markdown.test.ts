import { describe, expect, it } from 'bun:test'
import { markdownCadenceCommit, STREAMING_MARKDOWN_INTERVAL_MS } from '../src/ui/streaming-markdown.ts'

describe('streaming markdown cadence', () => {
  it('commits the first streaming token immediately, then waits out the interval', () => {
    const first = markdownCadenceCommit(0, 10, true)
    expect(first).toEqual({ commit: true, nextDelay: 0, resetClock: false })

    const tooSoon = markdownCadenceCommit(10, 10 + STREAMING_MARKDOWN_INTERVAL_MS - 1, true)
    expect(tooSoon.commit).toBe(false)
    expect(tooSoon.nextDelay).toBe(1)

    const due = markdownCadenceCommit(10, 10 + STREAMING_MARKDOWN_INTERVAL_MS, true)
    expect(due).toEqual({ commit: true, nextDelay: 0, resetClock: false })
  })

  it('flushes the full source as soon as the turn settles', () => {
    expect(markdownCadenceCommit(10, 12, false)).toEqual({ commit: true, nextDelay: 0, resetClock: true })
  })

  it('keeps a 2_000-token stream to a handful of markdown commits', () => {
    let clock = 0
    let commits = 0
    let lastCommit = 0
    for (let index = 0; index < 2_000; index += 1) {
      clock += 2
      const decision = markdownCadenceCommit(lastCommit, clock, true)
      if (!decision.commit) continue
      commits += 1
      lastCommit = clock
    }
    expect(commits).toBeGreaterThan(1)
    expect(commits).toBeLessThan(80)
  })
})
