import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { WorkspaceHost } from './server.ts'

// The workspace host that web and mobile clients connect to can be switched from Settings without restarting the
// desktop app. `off` runs nothing, `local` binds loopback for a browser on this machine, and `network` binds every
// interface so phones reach it over Tailscale or the LAN. The choice persists in preferences.json.

export type RemoteAccessMode = 'off' | 'local' | 'network'

export interface RemoteAccessState {
  mode: RemoteAccessMode
  host: WorkspaceHost | undefined
  // Set while a host is starting or stopping so the picker can disable itself.
  busy: boolean
  // The environment variable that pinned the mode, when one did.
  lockedBy: string | undefined
  error: string | undefined
}

export interface RemoteAccessOptions {
  initialMode: RemoteAccessMode
  preferencePath: string | false
  lockedBy?: string | undefined
  start(mode: Exclude<RemoteAccessMode, 'off'>): WorkspaceHost
}

export class RemoteAccessService {
  #options: RemoteAccessOptions
  #state: RemoteAccessState
  #listeners = new Set<() => void>()
  #transition: Promise<void> = Promise.resolve()

  constructor(options: RemoteAccessOptions) {
    this.#options = options
    let host: WorkspaceHost | undefined
    let error: string | undefined
    if (options.initialMode !== 'off') {
      try {
        host = options.start(options.initialMode)
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
      }
    }
    this.#state = { mode: host ? options.initialMode : 'off', host, busy: false, lockedBy: options.lockedBy, error }
  }

  get host(): WorkspaceHost | undefined {
    return this.#state.host
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  getSnapshot = (): RemoteAccessState => this.#state

  // Switches mode, restarting the host when the bind address changes. Concurrent calls queue in order.
  setMode(mode: RemoteAccessMode): Promise<void> {
    const run = async (): Promise<void> => {
      if (mode === this.#state.mode && !this.#state.error) return
      this.#set({ busy: true, error: undefined })
      try {
        if (this.#state.host) await this.#state.host.close()
        const host = mode === 'off' ? undefined : this.#options.start(mode)
        this.#set({ mode, host, busy: false })
        writeRemoteAccessMode(mode, this.#options.preferencePath)
      } catch (cause) {
        this.#set({ mode: 'off', host: undefined, busy: false, error: cause instanceof Error ? cause.message : String(cause) })
        throw cause
      }
    }
    this.#transition = this.#transition.then(run, run)
    return this.#transition
  }

  async close(): Promise<void> {
    await this.#transition.catch(() => undefined)
    if (this.#state.host) await this.#state.host.close()
    this.#set({ host: undefined, busy: false })
  }

  #set(patch: Partial<RemoteAccessState>): void {
    this.#state = { ...this.#state, ...patch }
    for (const listener of this.#listeners) listener()
  }
}

export function readRemoteAccessMode(path: string | false): RemoteAccessMode | undefined {
  if (!path) return undefined
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as { remoteAccess?: unknown }
    return value.remoteAccess === 'off' || value.remoteAccess === 'local' || value.remoteAccess === 'network' ? value.remoteAccess : undefined
  } catch {
    return undefined
  }
}

// Shares preferences.json with the theme and update channel, so the write merges into whatever is already there.
export function writeRemoteAccessMode(mode: RemoteAccessMode, path: string | false): void {
  if (!path) return
  let existing: Record<string, unknown> = {}
  try {
    existing = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    existing = {}
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...existing, remoteAccess: mode }, null, 2)}\n`, 'utf8')
}
