import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { attachJsonlReader, serializeJsonLine } from './jsonl.ts'
import {
  encodeTreeNavigateBridgeRequest,
  heddleworkFabricBridgePath,
  parseTreeNavigateBridgeEvent,
  type TreeNavigateBridgeEvent,
} from './fabric-bridge.ts'
import { discoverPiLiveBridges, heddleworkLiveBridgePath, parsePiLiveSessionStateRecord, PiLiveBridgeTransport, piLiveBridgeDirectory, type PiLiveBridgeAdvertisement } from './live-bridge.ts'
import type { AgentTransport, TransportStatus } from './transport.ts'
import { describePiAdapter, type HarnessAdapter, type HarnessCapabilities } from '../protocol/adapter.ts'
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

export class PiRpcTransport implements HarnessAdapter {
  readonly ownership = 'owned' as const
  readonly id = 'pi-rpc'
  readonly displayName = 'Pi (RPC)'
  readonly capabilities: HarnessCapabilities = describePiAdapter()
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
    const bridgeRoot = join(piLiveBridgeDirectory({ ...process.env, ...this.#options.env }), 'extension')
    const bridgeArgs = this.#options.fabricBridge === false
      ? []
      : ['--extension', heddleworkFabricBridgePath(), '--extension', heddleworkLiveBridgePath(bridgeRoot)]
    const args = [...(this.#options.commandArgs ?? []), '--mode', 'rpc', ...bridgeArgs, ...(this.#options.piArgs ?? [])]
    const env = piProcessEnvironment(command, { ...process.env, ...this.#options.env })
    const child = spawn(command, args, {
      cwd: this.#options.cwd,
      env,
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
    const liveState = parsePiLiveSessionStateRecord(record)
    if (liveState) {
      this.#emitEvent(liveState)
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

export interface CreatePiTransportOptions extends PiRpcTransportOptions {
  sessionFile?: string | undefined
  sessionId?: string | undefined
  liveAdvertisements?: readonly PiLiveBridgeAdvertisement[] | undefined
}

export function selectPiLiveAdvertisement(options: Pick<CreatePiTransportOptions, 'piArgs' | 'sessionFile' | 'sessionId'> & { cwd?: string }, advertisements: readonly PiLiveBridgeAdvertisement[]): PiLiveBridgeAdvertisement | undefined {
  const requestedFile = options.sessionFile ?? piArgumentValue(options.piArgs, '--session')
  const requestedId = options.sessionId ?? piArgumentValue(options.piArgs, '--session-id')
  if (!requestedFile && !requestedId) return undefined
  const path = requestedFile ? canonicalSessionPath(requestedFile, options.cwd) : undefined
  const matching = advertisements.filter((advertisement) => path
    ? Boolean(advertisement.sessionFile && canonicalSessionPath(advertisement.sessionFile) === path)
    : advertisement.sessionId === requestedId)
  if (matching.length > 1) throw new Error('Multiple Pi processes claim this session; close the duplicate owner before attaching')
  return matching[0]
}

function canonicalSessionPath(path: string, cwd = process.cwd()): string {
  const absolute = resolve(cwd, path)
  try { return comparablePath(realpathSync(absolute)) } catch { return comparablePath(absolute) }
}

/**
 * Prefer an already-running authoritative Pi process for the requested session.
 * Once selected, an attached transport never falls back to spawning another writer
 * if that owner disconnects; callers must explicitly choose a new owner/session.
 */
export function createPiTransport(options: CreatePiTransportOptions): AgentTransport {
  return new PiSelectingTransport(options)
}

class PiSelectingTransport implements AgentTransport {
  readonly #options: CreatePiTransportOptions
  readonly #eventListeners = new Set<(event: RpcRecord) => void>()
  readonly #statusListeners = new Set<(status: TransportStatus) => void>()
  #selected: AgentTransport | undefined
  #ownership: 'owned' | 'attached' | undefined
  #everAttached = false
  #identity: { sessionFile?: string | undefined; sessionId?: string | undefined; cwd: string } | undefined
  #forwarding: (() => void)[] = []
  #starting: Promise<void> | undefined
  #running = false
  #generation = 0
  constructor(options: CreatePiTransportOptions) { this.#options = options }
  get ownership(): 'owned' | 'attached' | undefined { return this.#ownership }
  start(): Promise<void> {
    if (this.#starting) return this.#starting
    if (this.#running) return Promise.reject(new Error('Pi transport is already started'))
    const task = this.#startSelection(++this.#generation).finally(() => { if (this.#starting === task) this.#starting = undefined })
    this.#starting = task
    return task
  }
  async #startSelection(generation: number): Promise<void> {
    // Recheck ownership on every reconnect, including a previously owned RPC
    // session. Another live frontend may have taken ownership while we were out.
    await this.#selected?.stop()
    for (const off of this.#forwarding.splice(0)) off()
    if (generation !== this.#generation) throw new Error('Pi transport startup was cancelled')
    const options = this.#currentOptions()
    const advertisements = options.liveAdvertisements ?? discoverPiLiveBridges(piLiveBridgeDirectory({ ...process.env, ...options.env }))
    const matching = selectPiLiveAdvertisement(options, advertisements)
    if (this.#everAttached && !matching) throw new Error('Previously attached Pi session owner is unavailable; refusing to spawn a second writer')
    const selected: AgentTransport = matching
      ? new PiLiveBridgeTransport({ advertisement: matching, ...(options.requestTimeoutMs === undefined ? {} : { requestTimeoutMs: options.requestTimeoutMs }) })
      : new PiRpcTransport(options)
    this.#selected = selected
    this.#ownership = selected.ownership
    if (selected.ownership === 'attached') this.#everAttached = true
    this.#forwarding = [
      selected.onEvent((event) => {
        if (generation !== this.#generation) return
        if (event.type === 'heddlework_session_state' || event.type === 'session_switched' || event.type === 'heddlework_live_snapshot') this.#observeState(event.state, event.cwd)
        for (const listener of this.#eventListeners) listener(event)
      }),
      selected.onStatus((status) => {
        if (generation !== this.#generation) return
        if (status.state === 'exited' || status.state === 'stopped') this.#running = false
        for (const listener of this.#statusListeners) listener(status)
      }),
    ]
    try {
      await selected.start()
      if (generation !== this.#generation) throw new Error('Pi transport startup was cancelled')
      this.#running = true
    } catch (error) {
      await selected.stop().catch(() => undefined)
      throw error
    }
  }
  #currentOptions(): CreatePiTransportOptions {
    if (!this.#identity) {
      if (!this.#options.sessionFile || piArgumentValue(this.#options.piArgs, '--session')) return this.#options
      return { ...this.#options, piArgs: [...(this.#options.piArgs ?? []), '--session', this.#options.sessionFile] }
    }
    const piArgs: string[] = []
    const original = this.#options.piArgs ?? []
    for (let index = 0; index < original.length; index++) {
      if (original[index] === '--session' || original[index] === '--session-id') { index++; continue }
      piArgs.push(original[index]!)
    }
    if (this.#identity.sessionFile) piArgs.push('--session', this.#identity.sessionFile)
    return { ...this.#options, ...this.#identity, piArgs }
  }
  #observeState(value: unknown, cwd?: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const state = value as Record<string, unknown>
    if (typeof state.sessionId !== 'string' && typeof state.sessionFile !== 'string') return
    this.#identity = {
      cwd: typeof cwd === 'string' && cwd ? resolve(cwd) : this.#identity?.cwd ?? this.#options.cwd,
      sessionId: typeof state.sessionId === 'string' ? state.sessionId : undefined,
      sessionFile: typeof state.sessionFile === 'string' && state.sessionFile ? canonicalSessionPath(state.sessionFile) : undefined,
    }
  }
  async stop(): Promise<void> {
    ++this.#generation
    this.#running = false
    await this.#selected?.stop()
    for (const off of this.#forwarding.splice(0)) off()
  }
  async request<T = unknown>(command: RpcCommand): Promise<T> {
    if (!this.#selected || !this.#running) throw new Error('Pi transport selector is not started')
    const result = await this.#selected.request<T>(command)
    if (command.type === 'get_state') this.#observeState(result)
    return result
  }
  send(record: RpcRecord): void { if (!this.#selected || !this.#running) throw new Error('Pi transport selector is not started'); this.#selected.send(record) }
  onEvent(listener: (event: RpcRecord) => void): () => void { this.#eventListeners.add(listener); return () => { this.#eventListeners.delete(listener) } }
  onStatus(listener: (status: TransportStatus) => void): () => void { this.#statusListeners.add(listener); return () => { this.#statusListeners.delete(listener) } }
  getStderr(): string { return this.#selected?.getStderr() ?? '' }
}

function piArgumentValue(args: readonly string[] | undefined, name: string): string | undefined {
  if (!args) return undefined
  const index = args.indexOf(name)
  const value = index >= 0 ? args[index + 1] : undefined
  return value && !value.startsWith('-') ? value : undefined
}

export function piProcessEnvironment(command: string, env: NodeJS.ProcessEnv, cwd = process.cwd(), home = homedir(), exists: (path: string) => boolean = existsSync): NodeJS.ProcessEnv {
  env = withToolchainPath(command, env, home, exists)
  if (!/[\\/]\.localterm[\\/]shims[\\/]pi(?:\.exe)?$/i.test(command) || env.PATH === undefined) return env

  // Bun lifecycle scripts prepend node_modules/.bin for the package directory and
  // every ancestor. LocalTerm resolves Pi again, so those entries can shadow the
  // user's installed executable.
  const packageBins = new Set<string>()
  let directory = resolve(cwd)
  while (true) {
    packageBins.add(comparablePath(join(directory, 'node_modules', '.bin')))
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  const path = env.PATH
    .split(delimiter)
    .filter((entry) => !entry || !packageBins.has(comparablePath(resolve(entry))))
    .join(delimiter)
  return path === env.PATH ? env : { ...env, PATH: path }
}

// Apps opened from Finder, Spotlight, or a .desktop file inherit launchd's or the session's minimal PATH. Pi is a
// `#!/usr/bin/env node` script, so even when its path is known the spawn fails with `env: node: No such file` unless
// the directory holding node is visible. Put Pi's own directory first, since its node usually sits beside it, then
// the usual toolchain locations the user's shell would have added.
function withToolchainPath(command: string, env: NodeJS.ProcessEnv, home: string, exists: (path: string) => boolean): NodeJS.ProcessEnv {
  if (process.platform === 'win32') return env
  const current = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const seen = new Set(current)
  const additions: string[] = []
  const commandDirectory = command.includes('/') ? dirname(resolve(command)) : undefined
  const candidates = [
    commandDirectory,
    join(home, '.bun', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    '/snap/bin',
  ]
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate) || !exists(candidate)) continue
    seen.add(candidate)
    additions.push(candidate)
  }
  if (additions.length === 0) return env
  // Pi's directory leads so a sibling node wins; the rest trail the inherited PATH so the user's shell order is kept.
  const leading = commandDirectory && additions[0] === commandDirectory ? [additions.shift()!] : []
  return { ...env, PATH: [...leading, ...current, ...additions].join(delimiter) }
}

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLowerCase() : path
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
