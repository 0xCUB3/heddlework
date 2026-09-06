export const TERMINAL_COMMAND_TYPES = ['openTerminal', 'writeTerminal', 'resizeTerminal', 'closeTerminal'] as const

export const MAX_TERMINAL_WRITE_CHARS = 8_192
export const MIN_TERMINAL_COLS = 2
export const MAX_TERMINAL_COLS = 240
export const MIN_TERMINAL_ROWS = 1
export const MAX_TERMINAL_ROWS = 80
export const DEFAULT_TERMINAL_COLS = 80
export const DEFAULT_TERMINAL_ROWS = 24

export type TerminalCommand =
  | { type: 'openTerminal'; cols?: number; rows?: number }
  | { type: 'writeTerminal'; id: string; data: string }
  | { type: 'resizeTerminal'; id: string; cols: number; rows: number }
  | { type: 'closeTerminal'; id: string }

export interface RemoteTerminalSession {
  id: string
  name: string
  title: string
  cwd: string
  cols: number
  rows: number
  status: 'running' | 'exited'
  exitCode?: number | null
}

export interface RemoteTerminalSnapshot {
  sessions: RemoteTerminalSession[]
  activeId?: string
}

export interface RemoteTerminalFrame {
  id: string
  cols: number
  rows: number
  cursorX: number
  cursorY: number
  cursorVisible: boolean
  title: string
  lines: string[]
}

export function isTerminalCommand(value: unknown): value is TerminalCommand {
  if (!value || typeof value !== 'object') return false
  const type = (value as { type?: unknown }).type
  return typeof type === 'string' && (TERMINAL_COMMAND_TYPES as readonly string[]).includes(type)
}

export interface TerminalCommandTarget {
  ensureSession(placement?: 'bottom' | 'right', size?: { cols: number; rows: number }): Promise<string>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number, owner?: 'bottom' | 'right'): void
  close(id: string): Promise<void>
  getStateSnapshot(): { sessions: ReadonlyArray<{ id: string }> }
}

export async function applyTerminalCommand(terminals: TerminalCommandTarget, command: TerminalCommand): Promise<void> {
  switch (command.type) {
    case 'openTerminal':
      await terminals.ensureSession('bottom', {
        cols: clampTerminalCols(command.cols),
        rows: clampTerminalRows(command.rows),
      })
      return
    case 'writeTerminal': {
      assertKnownTerminal(terminals, command.id)
      if (typeof command.data !== 'string' || command.data.length === 0) return
      if (command.data.length > MAX_TERMINAL_WRITE_CHARS) throw new Error('Terminal write too large')
      terminals.write(command.id, command.data)
      return
    }
    case 'resizeTerminal': {
      assertKnownTerminal(terminals, command.id)
      terminals.resize(command.id, clampTerminalCols(command.cols), clampTerminalRows(command.rows), 'bottom')
      return
    }
    case 'closeTerminal':
      assertKnownTerminal(terminals, command.id)
      await terminals.close(command.id)
      return
    default: {
      const unreachable: never = command
      throw new Error(`Unsupported terminal command: ${String((unreachable as { type?: unknown }).type)}`)
    }
  }
}

export function clampTerminalCols(value: unknown): number {
  return clampInt(value, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS, DEFAULT_TERMINAL_COLS)
}

export function clampTerminalRows(value: unknown): number {
  return clampInt(value, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS, DEFAULT_TERMINAL_ROWS)
}

function assertKnownTerminal(terminals: TerminalCommandTarget, id: unknown): asserts id is string {
  if (typeof id !== 'string' || !id) throw new Error('Unknown terminal')
  if (!terminals.getStateSnapshot().sessions.some((session) => session.id === id)) throw new Error(`Unknown terminal: ${id}`)
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const numeric = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.max(min, Math.min(max, Math.floor(numeric)))
}
