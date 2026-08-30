import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { attachJsonlReader, serializeJsonLine } from './jsonl.ts'
import {
  encodeTreeNavigateBridgeRequest,
  heddleworkFabricBridgePath,
  parseTreeNavigateBridgeEvent,
  type TreeNavigateBridgeEvent,
} from './fabric-bridge.ts'
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

interface PendingTreeNavigation {
  resolve(value: TreeNavigateBridgeEvent): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

export class PiRpcTransport implements AgentTransport {
  readonly #options: PiRpcTransportOptions
  readonly #eventListeners = new Set<(event: RpcRecord) => void>()
  readonly #statusListeners = new Set<(status: TransportStatus) => void>()
  readonly #pending = new Map<string, PendingRequest>()
  readonly #pendingTreeNavigations = new Map<string, PendingTreeNavigation>()
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
    if (command.type === 'navigate_tree') return this.#navigateTree(command) as Promise<T>
    return this.#requestPi(command)
  }

  #requestPi<T = unknown>(command: RpcCommand, timeoutMs = this.#options.requestTimeoutMs ?? 45_000): Promise<T> {
    const id = `workbench_${++this.#requestId}`
    const record = { ...command, id }
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

  async #navigateTree(command: RpcCommand): Promise<{ cancelled: boolean; editorText?: string | undefined }> {
    if (this.#options.fabricBridge === false) throw new Error('Session tree navigation requires the Heddlework Pi bridge')
    const targetId = typeof command.entryId === 'string' ? command.entryId : ''
    if (!targetId) throw new Error('Session tree navigation requires an entry ID')
    const requestId = `tree_${++this.#requestId}`
    const timeoutMs = typeof command.summarize === 'boolean' && command.summarize
      ? Math.max(this.#options.requestTimeoutMs ?? 45_000, 300_000)
      : this.#options.requestTimeoutMs ?? 45_000
    const eventPromise = new Promise<TreeNavigateBridgeEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingTreeNavigations.delete(requestId)
        reject(new Error('Timed out waiting for Pi session tree navigation'))
      }, timeoutMs)
      this.#pendingTreeNavigations.set(requestId, { resolve, reject, timer })
    })
    const requestPromise = this.#requestPi({
      type: 'prompt',
      message: encodeTreeNavigateBridgeRequest({
        requestId,
        targetId,
        ...(typeof command.summarize === 'boolean' ? { summarize: command.summarize } : {}),
        ...(typeof command.customInstructions === 'string' ? { customInstructions: command.customInstructions } : {}),
        ...(typeof command.replaceInstructions === 'boolean' ? { replaceInstructions: command.replaceInstructions } : {}),
        ...(typeof command.label === 'string' ? { label: command.label } : {}),
      }),
    }, timeoutMs)
    try {
      const [event] = await Promise.all([eventPromise, requestPromise])
      if (event.event === 'tree_error') throw new Error(event.error)
      return {
        cancelled: event.cancelled,
        ...(event.editorText === undefined ? {} : { editorText: event.editorText }),
      }
    } finally {
      const pending = this.#pendingTreeNavigations.get(requestId)
      if (pending) clearTimeout(pending.timer)
      this.#pendingTreeNavigations.delete(requestId)
    }
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
    const treeEvent = parseTreeNavigateBridgeEvent(record)
    if (treeEvent) {
      const pending = this.#pendingTreeNavigations.get(treeEvent.requestId)
      if (pending) {
        this.#pendingTreeNavigations.delete(treeEvent.requestId)
        clearTimeout(pending.timer)
        pending.resolve(treeEvent)
      }
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
    for (const pending of this.#pendingTreeNavigations.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pendingTreeNavigations.clear()
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
