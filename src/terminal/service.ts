import { randomUUID } from 'node:crypto'
import { BunPtyBackend, MemoryTerminalBackend, type TerminalBackend, type TerminalProcess } from './backend.ts'
import type {
  TerminalCleanup,
  TerminalGridSnapshot,
  TerminalPlacement,
  TerminalProcessStatus,
  TerminalServiceSnapshot,
  TerminalSessionId,
  TerminalSessionInfo,
  TerminalSpawnRequest,
} from './types.ts'
import { VtEmulator } from './vt.ts'

interface LiveSession {
  info: TerminalSessionInfo
  process: TerminalProcess
  vt: VtEmulator
  scrollOffset: number
  sizeOwner: TerminalPlacement | undefined
  cachedGrid: TerminalGridSnapshot | undefined
  cleanups: TerminalCleanup[]
}

export class TerminalSessionService {
  readonly #backend: TerminalBackend
  readonly #cwd: string
  readonly #sessions = new Map<TerminalSessionId, LiveSession>()
  readonly #listeners = new Set<() => void>()
  #snapshot: TerminalServiceSnapshot
  #activeBottomId: TerminalSessionId | undefined
  #activeRightId: TerminalSessionId | undefined
  #generation = 0
  #frame: ReturnType<typeof setTimeout> | undefined
  #disposed = false
  #seq = 0

  constructor(options: { cwd: string; backend?: TerminalBackend }) {
    this.#cwd = options.cwd
    this.#backend = options.backend ?? new BunPtyBackend()
    this.#snapshot = this.#publish(false)
  }

  readonly subscribe = (listener: () => void): TerminalCleanup => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): TerminalServiceSnapshot => this.#snapshot

  grid(id: TerminalSessionId | undefined): TerminalGridSnapshot | undefined {
    if (!id) return undefined
    const session = this.#sessions.get(id)
    if (!session) return undefined
    if (session.cachedGrid && session.cachedGrid.scrollOffset === session.scrollOffset) return session.cachedGrid
    const snap = session.vt.snapshot(session.scrollOffset)
    session.cachedGrid = snap
    return snap
  }

  async spawn(request: TerminalSpawnRequest = {}): Promise<TerminalSessionId> {
    if (this.#disposed) throw new Error('Terminal service is disposed')
    const cols = Math.max(2, request.cols ?? 80)
    const rows = Math.max(1, request.rows ?? 24)
    const cwd = request.cwd ?? this.#cwd
    this.#seq += 1
    const id = randomUUID()
    const name = request.name?.trim() || ('Terminal ' + String(this.#seq))
    const vt = new VtEmulator(cols, rows)
    const process = await this.#backend.spawn({ ...request, cols, rows, cwd })
    vt.onOutput = (data) => process.write(data)
    const session: LiveSession = {
      info: { id, name, title: name, cwd, cols, rows, status: { kind: 'running' } },
      process,
      vt,
      scrollOffset: 0,
      sizeOwner: undefined,
      cachedGrid: undefined,
      cleanups: [],
    }
    session.cleanups.push(process.onData((chunk) => {
      session.vt.write(chunk)
      session.scrollOffset = 0
      session.cachedGrid = undefined
      if (session.vt.title && session.vt.title !== session.info.title) session.info = { ...session.info, title: session.vt.title }
      this.#schedule()
    }))
    session.cleanups.push(process.onExit((status) => {
      session.info = { ...session.info, status }
      this.#schedule()
    }))
    this.#sessions.set(id, session)
    if (!this.#activeBottomId) this.#activeBottomId = id
    if (!this.#activeRightId) this.#activeRightId = id
    this.#schedule(true)
    return id
  }

  async ensureSession(placement?: TerminalPlacement, size?: { cols: number; rows: number }): Promise<TerminalSessionId> {
    const current = placement === 'right' ? this.#activeRightId : placement === 'bottom' ? this.#activeBottomId : (this.#activeBottomId ?? this.#activeRightId)
    if (current && this.#sessions.has(current)) return current
    const first = this.#snapshot.sessions[0]?.id
    if (first) {
      if (placement) this.select(placement, first)
      return first
    }
    return this.spawn(size)
  }

  select(placement: TerminalPlacement, id: TerminalSessionId | undefined): void {
    if (id && !this.#sessions.has(id)) return
    if (placement === 'bottom') this.#activeBottomId = id
    else this.#activeRightId = id
    this.#schedule(true)
  }

  write(id: TerminalSessionId, data: string): void {
    const session = this.#sessions.get(id)
    if (!session || session.info.status.kind === 'exited' || !data) return
    session.process.write(data)
    session.scrollOffset = 0
  }

  claimSize(id: TerminalSessionId, owner: TerminalPlacement): void {
    const session = this.#sessions.get(id)
    if (session) session.sizeOwner = owner
  }

  resize(id: TerminalSessionId, cols: number, rows: number, owner?: TerminalPlacement): void {
    const session = this.#sessions.get(id)
    if (!session) return
    const nextCols = Math.max(2, Math.floor(cols))
    const nextRows = Math.max(1, Math.floor(rows))
    if (owner && session.sizeOwner && session.sizeOwner !== owner) return
    if (owner) session.sizeOwner = owner
    session.process.resize(nextCols, nextRows)
    if (session.info.cols === nextCols && session.info.rows === nextRows) return
    session.vt.resize(nextCols, nextRows)
    session.info = { ...session.info, cols: nextCols, rows: nextRows }
    session.cachedGrid = undefined
    this.#schedule(true)
  }

  setScrollOffset(id: TerminalSessionId, offset: number): void {
    const session = this.#sessions.get(id)
    if (!session) return
    const next = Math.max(0, Math.min(session.vt.scrollbackLength, Math.floor(offset)))
    if (next === session.scrollOffset) return
    session.scrollOffset = next
    session.cachedGrid = undefined
    this.#schedule()
  }

  async close(id: TerminalSessionId): Promise<void> {
    const session = this.#sessions.get(id)
    if (!session) return
    for (const cleanup of session.cleanups.splice(0)) cleanup()
    session.process.kill()
    this.#sessions.delete(id)
    if (this.#activeBottomId === id) this.#activeBottomId = this.#sessions.keys().next().value
    if (this.#activeRightId === id) this.#activeRightId = this.#sessions.keys().next().value
    this.#schedule(true)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    if (this.#frame) clearTimeout(this.#frame)
    const ids = [...this.#sessions.keys()]
    for (const id of ids) await this.close(id)
    this.#listeners.clear()
  }

  #schedule(immediate = false): void {
    if (immediate) {
      if (this.#frame) {
        clearTimeout(this.#frame)
        this.#frame = undefined
      }
      this.#publish(true)
      return
    }
    if (this.#frame) return
    this.#frame = setTimeout(() => {
      this.#frame = undefined
      this.#publish(true)
    }, 16)
  }

  #publish(notify: boolean): TerminalServiceSnapshot {
    this.#generation += 1
    const sessions: TerminalSessionInfo[] = [...this.#sessions.values()].map((session) => session.info)
    this.#snapshot = {
      sessions,
      activeBottomId: this.#activeBottomId,
      activeRightId: this.#activeRightId,
      generation: this.#generation,
    }
    if (notify) for (const listener of this.#listeners) listener()
    return this.#snapshot
  }
}

export { MemoryTerminalBackend, BunPtyBackend }
