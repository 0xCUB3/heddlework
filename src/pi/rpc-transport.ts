import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { attachJsonlReader, serializeJsonLine } from './jsonl.ts'
import { heddleworkFabricBridgePath } from './fabric-bridge.ts'
import type { AgentTransport, TransportStatus } from './transport.ts'
import type { RpcCommand, RpcRecord } from './types.ts'

export interface PiRpcTransportOptions {
  cwd: string
  command?: string
  commandArgs?: string[]
  piArgs?: string[]
  env?: NodeJS.ProcessEnv
  requestTimeoutMs?: number
  fabricBridge?: boolean | undefined
}

interface PendingRequest {
  resolve(value: RpcRecord): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcTransport implements AgentTransport {
  readonly #options: PiRpcTransportOptions
  readonly #eventListeners = new Set<(event: RpcRecord) => void>()
  readonly #statusListeners = new Set<(status: TransportStatus) => void>()
  readonly #pending = new Map<string, PendingRequest>()
  #process: ChildProcessWithoutNullStreams | undefined
  #detachReader: (() => void) | undefined
  #requestId = 0
  #stderr = ''
  #exitError: Error | undefined

  constructor(options: PiRpcTransportOptions) {
    this.#options = options
  }

  async start(): Promise<void> {
    if (this.#process) throw new Error('Pi RPC transport is already started')
    this.#emitStatus({ state: 'starting' })
    this.#exitError = undefined
    this.#stderr = ''

    const command = this.#options.command ?? resolvePiExecutable()
    const bridgeArgs = this.#options.fabricBridge === false ? [] : ['--extension', heddleworkFabricBridgePath()]
    const args = [...(this.#options.commandArgs ?? []), '--mode', 'rpc', ...bridgeArgs, ...(this.#options.piArgs ?? [])]
    const child = spawn(command, args, {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.#process = child
    this.#detachReader = attachJsonlReader(child.stdout, (line) => this.#handleLine(line))

    child.stderr.on('data', (chunk: Buffer | string) => {
      this.#stderr = `${this.#stderr}${chunk.toString()}`.slice(-40_000)
    })
    child.stdin.on('error', (error) => this.#fail(error instanceof Error ? error : new Error(String(error))))
    child.once('error', (error) => this.#fail(new Error(`Unable to start Pi: ${error.message}`)))
    child.once('exit', (code, signal) => {
      if (this.#process !== child) return
      const error = new Error(`Pi exited (code=${String(code)}, signal=${String(signal)})${this.#stderr ? `: ${this.#stderr.trim()}` : ''}`)
      this.#exitError = error
      this.#rejectPending(error)
      this.#process = undefined
      this.#detachReader?.()
      this.#detachReader = undefined
      this.#emitStatus({ state: 'exited', message: error.message })
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    if (child.exitCode !== null || this.#exitError) throw this.#exitError ?? new Error('Pi exited during startup')
    this.#emitStatus({ state: 'running', ...(child.pid === undefined ? {} : { pid: child.pid }) })
  }

  async stop(): Promise<void> {
    const child = this.#process
    if (!child) {
      this.#emitStatus({ state: 'stopped' })
      return
    }
    this.#process = undefined
    this.#detachReader?.()
    this.#detachReader = undefined
    const error = new Error('Pi RPC transport stopped')
    this.#rejectPending(error)
    child.stdin.end()
    if (child.exitCode === null) child.kill('SIGTERM')
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve()
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 1_000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
    this.#emitStatus({ state: 'stopped' })
  }

  onEvent(listener: (event: RpcRecord) => void): () => void {
    this.#eventListeners.add(listener)
    return () => this.#eventListeners.delete(listener)
  }

  onStatus(listener: (status: TransportStatus) => void): () => void {
    this.#statusListeners.add(listener)
    return () => this.#statusListeners.delete(listener)
  }

  getStderr(): string {
    return this.#stderr
  }

  request<T = unknown>(command: RpcCommand): Promise<T> {
    const id = `workbench_${++this.#requestId}`
    const record = { ...command, id }
    const timeoutMs = this.#options.requestTimeoutMs ?? 45_000
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Timed out waiting for Pi command: ${command.type}`))
      }, timeoutMs)
      this.#pending.set(id, {
        timer,
        resolve: (response) => {
          if (!response.success) return reject(new Error(response.error ?? `Pi command failed: ${command.type}`))
          resolve(response.data as T)
        },
        reject,
      })
      try {
        this.send(record)
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  send(record: RpcRecord): void {
    const child = this.#process
    if (!child || child.stdin.destroyed || !child.stdin.writable) {
      throw this.#exitError ?? new Error('Pi RPC transport is not connected')
    }
    child.stdin.write(serializeJsonLine(record))
  }

  #handleLine(line: string): void {
    if (!line) return
    let record: RpcRecord
    try {
      record = JSON.parse(line) as RpcRecord
    } catch {
      this.#emitEvent({ type: 'transport_parse_error', line })
      return
    }
    if (record.type === 'response' && record.id) {
      const pending = this.#pending.get(record.id)
      if (pending) {
        this.#pending.delete(record.id)
        clearTimeout(pending.timer)
        pending.resolve(record)
        return
      }
    }
    this.#emitEvent(record)
  }

  #fail(error: Error): void {
    this.#exitError = error
    this.#rejectPending(error)
    this.#emitStatus({ state: 'exited', message: error.message })
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }

  #emitEvent(event: RpcRecord): void {
    for (const listener of this.#eventListeners) listener(event)
  }

  #emitStatus(status: TransportStatus): void {
    for (const listener of this.#statusListeners) listener(status)
  }
}

export interface PiExecutableResolutionOptions {
  configured?: string | undefined
  path?: string | undefined
  home?: string | undefined
  exists?(path: string): boolean
}

export function resolvePiExecutable(options: PiExecutableResolutionOptions = {}): string {
  const configured = options.configured ?? process.env.HEDDLEWORK_PI
  if (configured) return configured

  const exists = options.exists ?? existsSync
  const home = options.home ?? homedir()
  const localtermShim = join(home, '.localterm', 'shims', process.platform === 'win32' ? 'pi.exe' : 'pi')
  if (exists(localtermShim)) return localtermShim

  const pathEntries = (options.path ?? process.env.PATH ?? '').split(delimiter)
  for (const entry of pathEntries) {
    if (!entry) continue
    const candidate = join(entry, process.platform === 'win32' ? 'pi.exe' : 'pi')
    if (exists(candidate)) return candidate
  }

  const candidates = [
    join(home, '.local', 'bin', 'pi'),
    join(home, '.bun', 'bin', 'pi'),
    '/opt/homebrew/bin/pi',
    '/usr/local/bin/pi',
  ]
  return candidates.find(exists) ?? 'pi'
}
