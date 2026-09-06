import { describe, expect, it } from 'bun:test'
import { formatMessageUsage, formatTurnTelemetry } from '../src/workbench/telemetry.ts'
import { buildTimeline } from '../src/workbench/timeline.ts'
import { groupWorkItems } from '../src/ui/transcript-projection.ts'

describe('portable turn telemetry', () => {
  it('formats measured rates, timing, tokens, cache, stalls, and billed cost', () => {
    expect(formatTurnTelemetry({ tps: 54.23, timing: { totalMs: 8200, ttftMs: 410, stallMs: 1200, stallCount: 2 }, tokens: { input: 1500, output: 300, cacheRead: 2000 }, cost: { total: 0.123 }, billedCost: 0.05 })).toBe('TPS 54.2 · TTFT 0.4s · 8.2s · in 1.5k · out 300 · cache 2.0k · stall 1.2s ×2 · $0.0500')
  })
  it('never invents a rate or exposes arbitrary extension data', () => {
    expect(formatTurnTelemetry({ secret: 'private' })).toBeUndefined()
    expect(formatTurnTelemetry({ tps: Infinity, timing: { totalMs: -1 }, tokens: { output: 100 } })).toBeUndefined()
    expect(formatTurnTelemetry({ tps: null, timing: { totalMs: 200 }, tokens: { output: 5 } })).toBe('TPS — · 0.2s · out 5')
    expect(formatMessageUsage({ input: 12, output: 4, cost: { total: 0 } })).toBe('in 12 · out 4 · $0.0000')
    expect(formatMessageUsage(null)).toBeUndefined()
  })
  it('keeps TPS inside the existing Worked group even when it arrives after the answer', () => {
    const messages = [
      { role: 'user', content: 'Check it' },
      { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: 'ok' },
      { role: 'assistant', content: 'Done', usage: { input: 10, output: 2 } },
      { role: 'telemetry', content: 'TPS 10.0 · out 2' },
    ]
    const items = groupWorkItems(buildTimeline(messages, undefined, []))
    expect(items.map(item => item.kind)).toEqual(['user', 'work-trace', 'assistant'])
    expect(items[1]).toMatchObject({ kind: 'work-trace', items: [{ kind: 'tool' }, { kind: 'context-injection', source: 'turn metrics', text: 'TPS 10.0 · out 2' }] })
    expect(items[2]).toMatchObject({ kind: 'assistant', metrics: undefined })
    expect(buildTimeline(messages.slice(2, 3), undefined, [])[0]).toMatchObject({ kind: 'assistant', metrics: 'in 10 · out 2' })
  })
  it('never attaches a new turn’s metrics to an earlier turn', () => {
    const items = groupWorkItems(buildTimeline([
      { role: 'user', content: 'First' },
      { role: 'toolResult', toolCallId: 'read', toolName: 'read', content: 'ok' },
      { role: 'assistant', content: 'Done' },
      { role: 'user', content: 'Second' },
      { role: 'assistant', content: 'Answer' },
      { role: 'telemetry', content: 'TPS 5.0' },
    ], undefined, []))
    const traces = items.filter(item => item.kind === 'work-trace')
    expect(traces).toHaveLength(2)
    expect(traces[0]?.items).toHaveLength(1)
    expect(traces[1]?.items).toEqual([expect.objectContaining({ source: 'turn metrics', text: 'TPS 5.0' })])
  })
})
