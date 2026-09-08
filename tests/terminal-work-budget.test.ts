import { describe, expect, it } from 'bun:test'
import { createTerminalTurnBudget, createTerminalTurnGate, writeVtBounded } from '../src/terminal/work-budget.ts'

describe('terminal work budget', () => {
  it('bounds parse work per turn and defers the rest', () => {
    const budget = createTerminalTurnBudget({ maxBytes: 2048, maxMs: 50 })
    const input = new Uint8Array(10_000).fill(97)
    const written: number[] = []
    const rest = writeVtBounded((chunk) => written.push(chunk.byteLength), input, budget)
    expect(written).toEqual([2048])
    expect(rest.byteLength).toBe(10_000 - 2048)
    expect(budget.exhausted).toBe(true)

    const ignored = writeVtBounded(() => {
      throw new Error('parse continued after the turn budget')
    }, rest, budget)
    expect(ignored.byteLength).toBe(rest.byteLength)

    budget.beginTurn()
    const rest2 = writeVtBounded((chunk) => written.push(chunk.byteLength), rest, budget)
    expect(written).toEqual([2048, 2048])
    expect(rest2.byteLength).toBe(10_000 - 4096)
  })

  it('stops further project work in the same turn once time is spent', () => {
    const budget = createTerminalTurnBudget({ maxBytes: 1_000_000, maxMs: 4 })
    const first = writeVtBounded(() => {
      const end = performance.now() + 6
      while (performance.now() < end) { /* spend the turn */ }
    }, new Uint8Array(16), budget)
    expect(first.byteLength).toBe(0)
    expect(budget.exhausted).toBe(true)
    const leftover = writeVtBounded(() => {
      throw new Error('projected after the time budget')
    }, new Uint8Array(16), budget)
    expect(leftover.byteLength).toBe(16)
  })

  it('does not split UTF-8 characters or drop the remainder', () => {
    const budget = createTerminalTurnBudget({ maxBytes: 3, maxMs: 50 })
    const input = new TextEncoder().encode('🎯Z')
    const written: Uint8Array[] = []
    const rest = writeVtBounded((chunk) => written.push(chunk.slice()), input, budget)
    const taken = written.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    expect(taken + rest.byteLength).toBe(input.byteLength)
    expect(new TextDecoder().decode(written[0]!)).not.toContain('\uFFFD')
  })

  it('runs small frames immediately and defers work after the turn is exhausted', () => {
    const budget = createTerminalTurnBudget({ maxBytes: 32, maxMs: 8 })
    let scheduled: (() => void) | undefined
    const gate = createTerminalTurnGate(budget, (flush) => {
      scheduled = flush
      return 1
    }, () => {
      scheduled = undefined
    })
    const ran: string[] = []
    expect(gate.run(() => {
      ran.push('immediate')
      budget.consume(32, 0)
    })).toBe(true)
    expect(ran).toEqual(['immediate'])
    expect(gate.run(() => ran.push('deferred'))).toBe(false)
    expect(ran).toEqual(['immediate'])
    expect(scheduled).toBeTypeOf('function')
    scheduled!()
    expect(ran).toEqual(['immediate', 'deferred'])
    gate.dispose()
  })
})
