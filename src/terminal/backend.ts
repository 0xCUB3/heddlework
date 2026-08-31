import type { TerminalCleanup, TerminalProcessStatus, TerminalSpawnRequest } from './types.ts'

export interface TerminalProcess {
  readonly pid?: number
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  kill(): void
  onData(listener: (chunk: Uint8Array) => void): TerminalCleanup
  onExit(listener: (status: TerminalProcessStatus) => void): TerminalCleanup
}

export interface TerminalBackend {
  spawn(request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess>
}

interface BunTerminalHandle {
  write(data: string | Uint8Array): number
  resize(cols: number, rows: number): void
  close(): void
  readonly closed: boolean
}

interface BunTerminalCtor {
  new (options: {
    cols?: number
    rows?: number
    data?: (terminal: BunTerminalHandle, chunk: Uint8Array) => void
  }): BunTerminalHandle
}

function bunTerminalCtor(): BunTerminalCtor | undefined {
  const ctor = (Bun as unknown as { Terminal?: BunTerminalCtor }).Terminal
  return typeof ctor === 'function' ? ctor : undefined
}

export function bunTerminalAvailable(): boolean {
  return bunTerminalCtor() !== undefined
}

function defaultShell(): { command: string; args: string[] } {
  if (process.platform === 'win32') return { command: process.env.COMSPEC || 'cmd.exe', args: [] }
  const shell = process.env.SHELL || '/bin/bash'
  return { command: shell, args: ['-l'] }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  if (process.platform === 'win32') return false
  try {
    process.kill(-pid, signal)
    return true
  } catch {
    return false
  }
}

export class BunPtyBackend implements TerminalBackend {
  async spawn(request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const Terminal = bunTerminalCtor()
    if (!Terminal) throw new Error('Bun.Terminal is not available in this runtime')
    const dataListeners = new Set<(chunk: Uint8Array) => void>()
    const exitListeners = new Set<(status: TerminalProcessStatus) => void>()
    let status: TerminalProcessStatus = { kind: 'running' }
    const terminal = new Terminal({
      cols: request.cols,
      rows: request.rows,
      data(_handle, chunk) {
        const copy = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)
        for (const listener of dataListeners) listener(copy)
      },
    })
    const command = request.shell ?? defaultShell().command
    const args = request.args ? [...request.args] : request.shell ? [] : defaultShell().args
    const env = {
      ...process.env,
      ...request.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    }
    const subprocess = Bun.spawn([command, ...args], {
      cwd: request.cwd,
      env,
      terminal,
      ...(process.platform === 'win32' ? {} : { detached: true }),
    } as Parameters<typeof Bun.spawn>[1])
    void subprocess.exited.then((exitCode) => {
      if (status.kind === 'exited') return
      status = { kind: 'exited', exitCode: typeof exitCode === 'number' ? exitCode : null }
      for (const listener of exitListeners) listener(status)
      if (!terminal.closed) terminal.close()
    }).catch(() => {
      if (status.kind === 'exited') return
      status = { kind: 'exited', exitCode: null }
      for (const listener of exitListeners) listener(status)
    })
    return {
      pid: subprocess.pid,
      write(data) {
        if (status.kind === 'exited' || terminal.closed) return
        terminal.write(typeof data === 'string' ? data : data)
      },
      resize(cols, rows) {
        if (status.kind === 'exited' || terminal.closed) return
        terminal.resize(Math.max(2, cols), Math.max(1, rows))
        signalProcessGroup(subprocess.pid, 'SIGWINCH')
      },
      kill() {
        if (status.kind !== 'exited' && !signalProcessGroup(subprocess.pid, 'SIGTERM')) {
          try { subprocess.kill() } catch { /* already gone */ }
        }
        if (!terminal.closed) terminal.close()
      },
      onData(listener) {
        dataListeners.add(listener)
        return () => { dataListeners.delete(listener) }
      },
      onExit(listener) {
        exitListeners.add(listener)
        if (status.kind === 'exited') listener(status)
        return () => { exitListeners.delete(listener) }
      },
    }
  }
}

export class MemoryTerminalBackend implements TerminalBackend {
  readonly #script: string | Uint8Array | undefined

  constructor(script?: string | Uint8Array) {
    this.#script = script
  }

  async spawn(_request: TerminalSpawnRequest & { cols: number; rows: number; cwd: string }): Promise<TerminalProcess> {
    const dataListeners = new Set<(chunk: Uint8Array) => void>()
    const exitListeners = new Set<(status: TerminalProcessStatus) => void>()
    let status: TerminalProcessStatus = { kind: 'running' }
    const emit = (chunk: Uint8Array) => {
      for (const listener of dataListeners) listener(chunk)
    }
    const script = this.#script
    let scriptEmitted = false
    const emitScript = () => {
      if (scriptEmitted || !script) return
      scriptEmitted = true
      emit(typeof script === 'string' ? new TextEncoder().encode(script) : script)
    }
    return {
      write(data) {
        if (status.kind === 'exited') return
        emit(typeof data === 'string' ? new TextEncoder().encode(data) : data)
      },
      resize() {},
      kill() {
        if (status.kind === 'exited') return
        status = { kind: 'exited', exitCode: 0 }
        for (const listener of exitListeners) listener(status)
      },
      onData(listener) {
        dataListeners.add(listener)
        queueMicrotask(emitScript)
        return () => { dataListeners.delete(listener) }
      },
      onExit(listener) {
        exitListeners.add(listener)
        return () => { exitListeners.delete(listener) }
      },
    }
  }
}
