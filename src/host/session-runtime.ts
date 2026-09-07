import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { FlowRuntime } from '../flows/runtime.ts'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import type { WorkbenchCommand } from '../protocol/commands.ts'
import { writePrivateJson } from '../runtime/paths.ts'
import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkbenchState } from '../workbench/state.ts'
import { CommandJournal, type CommandAdmissionRecord } from './command-journal.ts'
import type { createRuntimeSessionFactory } from './runtime-composition.ts'

export type RuntimeSessionBundle = Awaited<ReturnType<ReturnType<typeof createRuntimeSessionFactory>>>

export type RegistrySessionStatus = 'active' | 'interrupted'

export interface SessionRuntimeOptions {
  initial: RuntimeSessionBundle
  createSession: ReturnType<typeof createRuntimeSessionFactory>
  path: string
  journalPath?: string | undefined
}

interface RegistryEntry {
  key: string
  id: string
  workspacePath: string
  status: RegistrySessionStatus
  sessionPath?: string | undefined
}

interface RegistryDocument {
  version: 1
  workspacePath: string
  sessions: RegistryEntry[]
}

function sessionStateDirectories(registryPath: string, entry: Pick<RegistryEntry, 'id' | 'sessionPath'>): string[] {
  const identities = new Set([entry.sessionPath, entry.id].filter((value): value is string => Boolean(value)))
  return [...identities].map((identity) => {
    const storageKey = createHash('sha256').update(identity).digest('hex').slice(0, 24)
    return join(dirname(registryPath), 'sessions', storageKey)
  })
}

function hasPersistedBackgroundWork(registryPath: string, entry: RegistryEntry): boolean {
  for (const stateDirectory of sessionStateDirectories(registryPath, entry)) {
    try {
      const flows = JSON.parse(readFileSync(join(stateDirectory, 'flows.json'), 'utf8')) as Record<string, unknown>
      const schedules = Array.isArray(flows.schedules) ? flows.schedules : []
      if (schedules.some((value) => value && typeof value === 'object' && (value as Record<string, unknown>).enabled === true)) return true
      if (Array.isArray(flows.pending) && flows.pending.length > 0) return true
      const runs = Array.isArray(flows.runs) ? flows.runs : []
      if (runs.some((value) => value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).tasks)
        && ((value as Record<string, unknown>).tasks as unknown[]).some((task) => task && typeof task === 'object'
          && ['pending', 'dispatched'].includes(String((task as Record<string, unknown>).status))))) return true
    } catch {
      // Missing or malformed flow state has no durable work to resume.
    }
    try {
      const queue = JSON.parse(readFileSync(join(stateDirectory, 'queue.json'), 'utf8')) as Record<string, unknown>
      const workspaces = queue.workspaces
      if (workspaces && typeof workspaces === 'object' && !Array.isArray(workspaces)) {
        for (const value of Object.values(workspaces as Record<string, unknown>)) {
          if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).items)
            && ((value as Record<string, unknown>).items as unknown[]).length > 0) return true
        }
      }
    } catch {
      // Missing or malformed queue state has nothing to resume.
    }
  }
  return false
}

export interface SessionAttachment {
  controller: WorkbenchController
  flows: FlowRuntime
  sessionPath: string | undefined
  sessionKey: string
}

export type SessionAdmissionDecision =
  | { action: 'execute' }
  | { action: 'respond'; record: CommandAdmissionRecord }

export class SessionAdmissionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionAdmissionError'
  }
}

function registryKey(sessionPath: string | undefined, id: string): string {
  return sessionPath ? resolve(sessionPath) : `id:${id}`
}

function isAliasRegistryKey(key: string): boolean {
  return key.startsWith('id:')
}

function controllerIsBusy(snapshot: WorkbenchState): boolean {
  if (snapshot.session.isStreaming) return true
  if (snapshot.queue.dispatchingId) return true
  if (snapshot.queue.blockingActivity) return true
  if (snapshot.dialog) return true
  if (snapshot.dialogQueue.length > 0) return true
  if (snapshot.questionnaireSubmitting) return true
  return false
}

export class SessionRuntime {
  readonly #createSession: ReturnType<typeof createRuntimeSessionFactory>
  readonly #registryPath: string
  readonly #journal: CommandJournal
  readonly #sessions = new Map<string, RuntimeSessionBundle>()
  // Remember unopened sessions without spawning one Pi process per historical tab.
  readonly #restored = new Map<string, RegistryEntry>()
  readonly #started = new Set<string>()
  readonly #creating = new Map<string, Promise<RuntimeSessionBundle>>()
  readonly #workspacePath: string
  #defaultKey: string
  readonly #snapshotUnsubs = new Map<string, () => void>()
  readonly #snapshotListeners = new Set<(sessionKey: string) => void>()
  readonly #flowUnsubs = new Map<string, () => void>()
  readonly #flowListeners = new Set<(sessionKey: string) => void>()
  readonly #sessionKeyListeners = new Set<(fromKey: string, toKey: string) => void>()

  constructor(options: SessionRuntimeOptions) {
    this.#createSession = options.createSession
    this.#registryPath = options.path
    this.#journal = new CommandJournal(options.journalPath ?? options.path.replace(/registry\.json$/u, 'command-journal.json'))
    this.#workspacePath = options.initial.controller.getSnapshot().workspacePath
    const sessionPath = options.initial.controller.getSnapshot().session.sessionFile
    this.#defaultKey = registryKey(sessionPath, 'default')
    this.#sessions.set(this.#defaultKey, options.initial)
    this.#wireSession(this.#defaultKey, options.initial)
    this.#restoreRegistry(sessionPath)
    this.#persistRegistry()
  }

  get defaultSessionKey(): string {
    return this.#defaultKey
  }

  forEachSession(visitor: (sessionKey: string, bundle: RuntimeSessionBundle) => void): void {
    for (const [sessionKey, bundle] of this.#sessions) visitor(sessionKey, bundle)
  }

  subscribeSnapshots(listener: (sessionKey: string) => void): () => void {
    this.#snapshotListeners.add(listener)
    return () => { this.#snapshotListeners.delete(listener) }
  }

  subscribeFlowSnapshots(listener: (sessionKey: string) => void): () => void {
    this.#flowListeners.add(listener)
    return () => { this.#flowListeners.delete(listener) }
  }

  subscribeSessionKeys(listener: (fromKey: string, toKey: string) => void): () => void {
    this.#sessionKeyListeners.add(listener)
    return () => { this.#sessionKeyListeners.delete(listener) }
  }

  isBusy(): boolean {
    if (this.#creating.size > 0) return true
    if (this.#journal.hasInFlight()) return true
    for (const session of this.#sessions.values()) {
      if (controllerIsBusy(session.controller.getSnapshot())) return true
    }
    return false
  }

  attach(sessionPath?: string | undefined): SessionAttachment {
    const key = sessionPath ? resolve(sessionPath) : this.#defaultKey
    const session = this.#sessions.get(key) ?? this.#findSessionByPath(sessionPath) ?? this.#sessions.get(this.#defaultKey)
    if (!session) throw new Error('No runtime session is available')
    const resolvedKey = this.#keyForBundle(session) ?? key
    const activePath = session.controller.getSnapshot().session.sessionFile
    return { controller: session.controller, flows: session.flows, sessionPath: activePath, sessionKey: resolvedKey }
  }

  bundleForKey(sessionKey: string): RuntimeSessionBundle | undefined {
    return this.#sessions.get(sessionKey) ?? this.#findSessionByPath(sessionKey)
  }

  async startInitial(): Promise<void> {
    const bundle = this.#sessions.get(this.#defaultKey)
    if (!bundle) throw new Error('No initial runtime session is available')
    await this.#start(this.#defaultKey, bundle)
    this.#reindexDefaultSession()
    this.#persistRegistry()
  }

  async ensureSession(sessionPath: string, summary?: PiSessionSummary): Promise<RuntimeSessionBundle> {
    const key = resolve(sessionPath)
    const pending = this.#creating.get(key)
    if (pending) return pending
    const existing = this.#sessions.get(key) ?? this.#findSessionByPath(key)
    if (existing) return existing
    const restored = this.#restored.get(key)
    const task = this.#createSession({
      workspacePath: resolve(summary?.cwd || restored?.workspacePath || this.#workspacePath),
      sessionPath: key,
      id: summary?.id ?? restored?.id ?? key,
    }).then(async (bundle) => {
      this.#sessions.set(key, bundle)
      this.#wireSession(key, bundle)
      await this.#start(key, bundle)
      this.#restored.delete(key)
      this.#persistRegistry()
      return bundle
    }).finally(() => {
      this.#creating.delete(key)
    })
    this.#creating.set(key, task)
    return task
  }

  async createNewSession(workspacePath: string): Promise<{ sessionKey: string; bundle: RuntimeSessionBundle }> {
    const id = crypto.randomUUID()
    let key = registryKey(undefined, id)
    const bundle = await this.#createSession({ workspacePath: resolve(workspacePath), id })
    this.#sessions.set(key, bundle)
    this.#wireSession(key, bundle)
    await this.#start(key, bundle)
    await bundle.controller.newSession()
    key = this.#assignPathKey(key, bundle)
    this.#persistRegistry()
    return { sessionKey: key, bundle }
  }

  async openWorkspace(workspacePath: string): Promise<{ sessionKey: string; bundle: RuntimeSessionBundle }> {
    const target = resolve(workspacePath)
    for (const [key, bundle] of this.#sessions) {
      if (resolve(bundle.controller.getSnapshot().workspacePath) !== target) continue
      const sessionPath = bundle.controller.getSnapshot().session.sessionFile
      if (sessionPath) return { sessionKey: resolve(sessionPath), bundle }
      return { sessionKey: key, bundle }
    }
    const id = crypto.randomUUID()
    let key = registryKey(undefined, id)
    const bundle = await this.#createSession({ workspacePath: target, id })
    this.#sessions.set(key, bundle)
    this.#wireSession(key, bundle)
    await this.#start(key, bundle)
    await bundle.controller.switchWorkspace(target)
    key = this.#assignPathKey(key, bundle)
    this.#persistRegistry()
    return { sessionKey: key, bundle }
  }

  admission(clientId: string, requestId: string, command: WorkbenchCommand, sessionKey: string): SessionAdmissionDecision {
    if (!this.#journal.needsAdmission(command)) return { action: 'execute' }
    const fingerprint = this.#journal.fingerprint(command, sessionKey)
    const prior = this.#journal.lookup(clientId, requestId)
    if (prior) {
      if (prior.fingerprint && prior.fingerprint !== fingerprint) {
        throw new SessionAdmissionError('Command admission fingerprint mismatch')
      }
      return { action: 'respond', record: prior }
    }
    this.#journal.admit(clientId, requestId, fingerprint)
    return { action: 'execute' }
  }

  recordCommandResult(clientId: string, requestId: string, command: WorkbenchCommand, sessionKey: string, ok: boolean, value?: unknown, error?: string): void {
    if (!this.#journal.needsAdmission(command)) return
    const fingerprint = this.#journal.fingerprint(command, sessionKey)
    this.#journal.complete(clientId, requestId, {
      ok,
      fingerprint,
      ...(ok && value !== undefined ? { value } : {}),
      ...(!ok ? { error: error ?? 'failed' } : {}),
    })
  }

  async dispose(): Promise<void> {
    for (const unsub of [...this.#snapshotUnsubs.values(), ...this.#flowUnsubs.values()]) unsub()
    this.#snapshotUnsubs.clear()
    this.#flowUnsubs.clear()
    this.#snapshotListeners.clear()
    this.#flowListeners.clear()
    this.#sessionKeyListeners.clear()
    for (const session of this.#sessions.values()) await session.dispose()
    this.#sessions.clear()
    this.#started.clear()
    this.#creating.clear()
    this.#restored.clear()
  }

  #findSessionByPath(sessionPath: string | undefined): RuntimeSessionBundle | undefined {
    if (!sessionPath) return undefined
    const target = resolve(sessionPath)
    for (const bundle of this.#sessions.values()) {
      const file = bundle.controller.getSnapshot().session.sessionFile
      if (file && resolve(file) === target) return bundle
    }
    return undefined
  }

  #keyForBundle(bundle: RuntimeSessionBundle): string | undefined {
    for (const [key, candidate] of this.#sessions) {
      if (candidate === bundle) return key
    }
    return undefined
  }

  #assignPathKey(temporaryKey: string, bundle: RuntimeSessionBundle): string {
    const sessionPath = bundle.controller.getSnapshot().session.sessionFile
    if (!sessionPath) return temporaryKey
    const pathKey = resolve(sessionPath)
    return pathKey === temporaryKey ? temporaryKey : this.#moveSessionKey(temporaryKey, pathKey, bundle)
  }

  #reindexDefaultSession(): void {
    const bundle = this.#sessions.get(this.#defaultKey)
    if (!bundle) return
    const sessionPath = bundle.controller.getSnapshot().session.sessionFile
    if (!sessionPath) return
    const pathKey = resolve(sessionPath)
    if (pathKey === this.#defaultKey) return
    if (this.#sessions.get(pathKey) === bundle) {
      this.#defaultKey = pathKey
      return
    }
    this.#sessions.set(pathKey, bundle)
    if (isAliasRegistryKey(this.#defaultKey)) this.#sessions.delete(this.#defaultKey)
    this.#migrateSessionSubscriptions(this.#defaultKey, pathKey)
    if (this.#started.has(this.#defaultKey)) {
      this.#started.delete(this.#defaultKey)
      this.#started.add(pathKey)
    }
    this.#defaultKey = pathKey
  }

  #migrateSessionSubscriptions(fromKey: string, toKey: string): void {
    const snapshotUnsub = this.#snapshotUnsubs.get(fromKey)
    if (snapshotUnsub) {
      this.#snapshotUnsubs.delete(fromKey)
      this.#snapshotUnsubs.set(toKey, snapshotUnsub)
    }
    const flowUnsub = this.#flowUnsubs.get(fromKey)
    if (flowUnsub) {
      this.#flowUnsubs.delete(fromKey)
      this.#flowUnsubs.set(toKey, flowUnsub)
    }
  }


  #wireSession(sessionKey: string, bundle: RuntimeSessionBundle): void {
    if (!this.#snapshotUnsubs.has(sessionKey)) {
      this.#snapshotUnsubs.set(sessionKey, bundle.controller.subscribe(() => {
        let currentKey = this.#keyForBundle(bundle) ?? sessionKey
        const sessionPath = bundle.controller.getSnapshot().session.sessionFile
        if (sessionPath) {
          const pathKey = resolve(sessionPath)
          if (pathKey !== currentKey) currentKey = this.#moveSessionKey(currentKey, pathKey, bundle)
        }
        for (const listener of this.#snapshotListeners) listener(currentKey)
      }))
    }
    if (!this.#flowUnsubs.has(sessionKey)) {
      this.#flowUnsubs.set(sessionKey, bundle.flows.subscribe(() => {
        const currentKey = this.#keyForBundle(bundle) ?? sessionKey
        for (const listener of this.#flowListeners) listener(currentKey)
      }))
    }
  }

  #moveSessionKey(fromKey: string, desiredKey: string, bundle: RuntimeSessionBundle): string {
    if (fromKey === desiredKey) return fromKey
    const occupant = this.#sessions.get(desiredKey)
    const snapshot = bundle.controller.getSnapshot()
    const toKey = occupant && occupant !== bundle
      ? registryKey(undefined, snapshot.session.sessionId ?? `${desiredKey}:${fromKey}`)
      : desiredKey
    if (toKey === fromKey) return fromKey
    this.#sessions.set(toKey, bundle)
    if (this.#sessions.get(fromKey) === bundle) this.#sessions.delete(fromKey)
    this.#migrateSessionSubscriptions(fromKey, toKey)
    if (this.#started.has(fromKey)) {
      this.#started.delete(fromKey)
      this.#started.add(toKey)
    }
    if (this.#defaultKey === fromKey) this.#defaultKey = toKey
    this.#persistRegistry()
    for (const listener of this.#sessionKeyListeners) listener(fromKey, toKey)
    return toKey
  }

  async #start(key: string, bundle: RuntimeSessionBundle): Promise<void> {
    if (this.#started.has(key)) return
    this.#started.add(key)
    await bundle.controller.start()
  }

  #restoreRegistry(initialSessionPath: string | undefined): void {
    if (!existsSync(this.#registryPath)) return
    let document: RegistryDocument
    try {
      document = JSON.parse(readFileSync(this.#registryPath, 'utf8')) as RegistryDocument
    } catch {
      return
    }
    if (document.version !== 1 || !Array.isArray(document.sessions)) return
    for (const entry of document.sessions) {
      try {
        if (typeof entry.sessionPath !== 'string' || !entry.sessionPath || isAliasRegistryKey(entry.sessionPath)) continue
        const key = resolve(entry.sessionPath)
        if (this.#sessions.has(key)) continue
        if (initialSessionPath && key === resolve(initialSessionPath)) continue
        if (entry.key && isAliasRegistryKey(entry.key) && !entry.sessionPath) continue
        this.#restored.set(key, {
          key,
          id: typeof entry.id === 'string' ? entry.id : key,
          sessionPath: key,
          workspacePath: typeof entry.workspacePath === 'string' ? entry.workspacePath : document.workspacePath,
          // In-flight work cannot be assumed to have survived a host restart.
          status: entry.status === 'interrupted' ? 'interrupted' : 'active',
        })
        const restored = this.#restored.get(key)!
        if (hasPersistedBackgroundWork(this.#registryPath, restored)) {
          void this.ensureSession(key).catch(() => {
            // Keep failed background restores lazy so opening the thread can retry later.
          })
        }
      } catch {
        // Skip malformed registry rows.
      }
    }
  }

  #persistRegistry(): void {
    const sessions: RegistryEntry[] = []
    const seen = new Set<RuntimeSessionBundle>()
    for (const [key, bundle] of this.#sessions) {
      if (seen.has(bundle)) continue
      seen.add(bundle)
      const snapshot = bundle.controller.getSnapshot()
      const sessionPath = snapshot.session.sessionFile
      const workspacePath = resolve(snapshot.workspacePath)
      const interrupted = controllerIsBusy(snapshot) ? 'interrupted' as const : 'active' as const
      sessions.push({
        key,
        id: snapshot.session.sessionId ?? key,
        workspacePath,
        status: interrupted,
        ...(sessionPath ? { sessionPath: resolve(sessionPath) } : {}),
      })
    }
    const livePaths = new Set(sessions.map((entry) => entry.sessionPath))
    for (const entry of this.#restored.values()) {
      if (!livePaths.has(entry.sessionPath)) sessions.push(entry)
    }
    writePrivateJson(this.#registryPath, {
      version: 1,
      workspacePath: this.#workspacePath,
      sessions,
    } satisfies RegistryDocument)
  }
}
