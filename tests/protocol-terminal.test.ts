import { describe, expect, it } from 'bun:test'
import {
  applyTerminalCommand,
  isTerminalCommand,
  isWorkbenchCommand,
  MAX_TERMINAL_WRITE_CHARS,
  TERMINAL_COMMAND_TYPES,
} from '../src/protocol/index.ts'
import type { TerminalCommandTarget } from '../src/protocol/terminal.ts'

function fakeTerminal(ids = ['term-1']): TerminalCommandTarget & {
  writes: Array<{ id: string; data: string }>
  resizes: Array<{ id: string; cols: number; rows: number }>
  closed: string[]
  spawned: number
} {
  const sessions = ids.map((id) => ({ id }))
  return {
    writes: [],
    resizes: [],
    closed: [],
    spawned: 0,
    async ensureSession(_placement, size) {
      this.spawned += 1
      if (sessions.length === 0) sessions.push({ id: 'term-new' })
      if (size) this.resizes.push({ id: sessions[0]!.id, cols: size.cols, rows: size.rows })
      return sessions[0]!.id
    },
    write(id, data) { this.writes.push({ id, data }) },
    resize(id, cols, rows) { this.resizes.push({ id, cols, rows }) },
    async close(id) { this.closed.push(id) },
    getStateSnapshot() { return { sessions } },
  }
}

describe('terminal command protocol', () => {
  it('recognises terminal commands and rejects unknown ones', () => {
    for (const type of TERMINAL_COMMAND_TYPES) expect(isTerminalCommand({ type })).toBe(true)
    expect(isWorkbenchCommand({ type: 'openTerminal' })).toBe(true)
    expect(isWorkbenchCommand({ type: 'writeTerminal', id: 't', data: 'a' })).toBe(true)
    expect(isTerminalCommand({ type: 'explode' })).toBe(false)
  })

  it('opens, writes, resizes, and closes through the typed target', async () => {
    const terminals = fakeTerminal()
    await applyTerminalCommand(terminals, { type: 'openTerminal', cols: 40, rows: 12 })
    expect(terminals.spawned).toBe(1)
    await applyTerminalCommand(terminals, { type: 'writeTerminal', id: 'term-1', data: 'printf hi\n' })
    expect(terminals.writes).toEqual([{ id: 'term-1', data: 'printf hi\n' }])
    await applyTerminalCommand(terminals, { type: 'resizeTerminal', id: 'term-1', cols: 100, rows: 30 })
    expect(terminals.resizes.at(-1)).toEqual({ id: 'term-1', cols: 100, rows: 30 })
    await applyTerminalCommand(terminals, { type: 'closeTerminal', id: 'term-1' })
    expect(terminals.closed).toEqual(['term-1'])
  })

  it('rejects unknown ids and oversized writes', async () => {
    const terminals = fakeTerminal()
    await expect(applyTerminalCommand(terminals, { type: 'writeTerminal', id: 'missing', data: 'x' })).rejects.toThrow('Unknown terminal')
    await expect(applyTerminalCommand(terminals, { type: 'writeTerminal', id: 'term-1', data: 'x'.repeat(MAX_TERMINAL_WRITE_CHARS + 1) })).rejects.toThrow('too large')
  })

  it('clamps remote cols and rows', async () => {
    const terminals = fakeTerminal([])
    await applyTerminalCommand(terminals, { type: 'openTerminal', cols: 9_999, rows: -3 })
    expect(terminals.resizes[0]?.cols).toBe(240)
    expect(terminals.resizes[0]?.rows).toBe(1)
  })
})
