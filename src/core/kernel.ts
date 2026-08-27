export type Cleanup = () => void | Promise<void>

export interface ServiceToken<T> {
  readonly key: symbol
  readonly name: string
  readonly _type?: T
}

export interface SlotToken<T> {
  readonly key: symbol
  readonly name: string
  readonly _type?: T
}

export interface WorkbenchEvents {}

export interface EventOptions {
  prepend?: boolean
}

type EventName = keyof WorkbenchEvents
type EventHandler<K extends EventName> = Extract<WorkbenchEvents[K], (...args: any[]) => any>
type EventArgs<K extends EventName> = Parameters<EventHandler<K>>
type EventResult<K extends EventName> = ReturnType<EventHandler<K>>
type EventListener = (...args: any[]) => any

export function serviceToken<T>(name: string): ServiceToken<T> {
  return { key: Symbol(name), name }
}

export function slotToken<T>(name: string): SlotToken<T> {
  return { key: Symbol(name), name }
}

export interface PluginContext {
  get<T>(token: ServiceToken<T>): T
  provide<T>(token: ServiceToken<T>, value: T): void
  effect(setup: () => void | Cleanup): void
  contribute<T>(slot: SlotToken<T>, key: string, value: T): void
  on<K extends EventName>(name: K, listener: EventHandler<K>, options?: EventOptions): Cleanup
  emit<K extends EventName>(name: K, ...args: EventArgs<K>): void
  parallel<K extends EventName>(name: K, ...args: EventArgs<K>): Promise<void>
  serial<K extends EventName>(name: K, ...args: EventArgs<K>): Promise<Awaited<EventResult<K>> | undefined>
  bail<K extends EventName>(name: K, ...args: EventArgs<K>): EventResult<K> | undefined
  waterfall<K extends EventName>(name: K, ...args: EventArgs<K>): EventResult<K>
}

export interface WorkbenchPlugin {
  readonly id: string
  readonly requires?: readonly ServiceToken<unknown>[]
  activate(context: PluginContext): void | Cleanup
}

interface Contribution<T = unknown> {
  owner: string
  value: T
}

interface ListenerRecord {
  owner: string
  callback: EventListener
}

interface MountedPlugin {
  plugin: WorkbenchPlugin
  cleanups: Cleanup[]
  status: 'pending' | 'activating' | 'active' | 'deactivating'
}

export class WorkbenchKernel {
  readonly #services = new Map<symbol, { owner: string; value: unknown }>()
  readonly #contributions = new Map<symbol, Map<string, Contribution[]>>()
  readonly #listeners = new Map<PropertyKey, ListenerRecord[]>()
  readonly #mounted: MountedPlugin[] = []
  #reconciling = false
  #disposed = false

  get<T>(token: ServiceToken<T>): T {
    const record = this.#services.get(token.key)
    if (!record) throw new Error(`Missing service: ${token.name}`)
    return record.value as T
  }

  contributions<T>(slot: SlotToken<T>): ReadonlyMap<string, T> {
    const keyed = this.#contributions.get(slot.key)
    const visible = new Map<string, T>()
    if (!keyed) return visible
    for (const [key, stack] of keyed) {
      const current = stack.at(-1)
      if (current) visible.set(key, current.value as T)
    }
    return visible
  }

  mount(plugin: WorkbenchPlugin): Cleanup {
    if (this.#disposed) throw new Error('Workbench kernel is disposed')
    if (this.#mounted.some((entry) => entry.plugin.id === plugin.id)) {
      throw new Error(`Plugin already mounted: ${plugin.id}`)
    }

    const mounted: MountedPlugin = { plugin, cleanups: [], status: 'pending' }
    this.#mounted.push(mounted)
    try {
      this.#reconcile()
    } catch (error) {
      this.#removeImmediately(mounted)
      throw error
    }

    return async () => this.#unmount(mounted)
  }

  emit<K extends EventName>(name: K, ...args: EventArgs<K>): void {
    for (const listener of this.#eventListeners(name)) listener(...args)
  }

  async parallel<K extends EventName>(name: K, ...args: EventArgs<K>): Promise<void> {
    const results = await Promise.allSettled(this.#eventListeners(name).map(async (listener) => listener(...args)))
    const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (errors.length > 0) throw new AggregateError(errors.map((error) => error.reason), `Event failed: ${String(name)}`)
  }

  async serial<K extends EventName>(name: K, ...args: EventArgs<K>): Promise<Awaited<EventResult<K>> | undefined> {
    for (const listener of this.#eventListeners(name)) {
      const result = await listener(...args) as Awaited<EventResult<K>>
      if (isBailed(result)) return result
    }
    return undefined
  }

  bail<K extends EventName>(name: K, ...args: EventArgs<K>): EventResult<K> | undefined {
    for (const listener of this.#eventListeners(name)) {
      const result = listener(...args) as EventResult<K>
      if (isBailed(result)) return result
    }
    return undefined
  }

  waterfall<K extends EventName>(name: K, ...args: EventArgs<K>): EventResult<K> {
    const listeners = this.#eventListeners(name)
    const parameters = [...args] as unknown[]
    const inner = parameters.pop()
    if (typeof inner !== 'function') throw new Error(`Waterfall event requires a final next callback: ${String(name)}`)
    let index = 0
    const next = (): EventResult<K> => {
      const listener = listeners[index++] ?? inner
      return listener(...parameters, next) as EventResult<K>
    }
    return next()
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    const errors: unknown[] = []
    for (const mounted of [...this.#mounted].reverse()) {
      try {
        await this.#unmount(mounted)
      } catch (error) {
        errors.push(error)
      }
    }
    this.#listeners.clear()
    if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose workbench kernel')
  }

  #reconcile(): void {
    if (this.#reconciling || this.#disposed) return
    this.#reconciling = true
    try {
      let progressed = true
      while (progressed) {
        progressed = false
        for (const mounted of this.#mounted) {
          if (mounted.status !== 'pending' || !this.#requirementsAvailable(mounted.plugin)) continue
          this.#activate(mounted)
          progressed = true
        }
      }
    } finally {
      this.#reconciling = false
    }
  }

  #requirementsAvailable(plugin: WorkbenchPlugin): boolean {
    return (plugin.requires ?? []).every((token) => this.#services.has(token.key))
  }

  #activate(mounted: MountedPlugin): void {
    mounted.status = 'activating'
    const plugin = mounted.plugin
    const kernel = this
    const context: PluginContext = {
      get<T>(token: ServiceToken<T>): T {
        return kernel.get(token)
      },
      provide<T>(token: ServiceToken<T>, value: T): void {
        if (kernel.#services.has(token.key)) throw new Error(`Service already provided: ${token.name}`)
        kernel.#services.set(token.key, { owner: plugin.id, value })
        mounted.cleanups.push(() => {
          const current = kernel.#services.get(token.key)
          if (current?.owner === plugin.id) kernel.#services.delete(token.key)
        })
      },
      effect(setup): void {
        const cleanup = setup()
        if (cleanup) mounted.cleanups.push(cleanup)
      },
      contribute<T>(slot: SlotToken<T>, key: string, value: T): void {
        let keyed = kernel.#contributions.get(slot.key)
        if (!keyed) {
          keyed = new Map()
          kernel.#contributions.set(slot.key, keyed)
        }
        let stack = keyed.get(key)
        if (!stack) {
          stack = []
          keyed.set(key, stack)
        }
        const contribution: Contribution<T> = { owner: plugin.id, value }
        stack.push(contribution as Contribution)
        mounted.cleanups.push(() => {
          const index = stack?.indexOf(contribution as Contribution) ?? -1
          if (index >= 0) stack?.splice(index, 1)
          if (stack?.length === 0) keyed?.delete(key)
          if (keyed?.size === 0) kernel.#contributions.delete(slot.key)
        })
      },
      on<K extends EventName>(name: K, listener: EventHandler<K>, options: EventOptions = {}): Cleanup {
        const cleanup = kernel.#listen(plugin.id, name, listener as EventListener, options)
        mounted.cleanups.push(cleanup)
        return cleanup
      },
      emit<K extends EventName>(name: K, ...args: EventArgs<K>): void {
        kernel.emit(name, ...args)
      },
      parallel<K extends EventName>(name: K, ...args: EventArgs<K>): Promise<void> {
        return kernel.parallel(name, ...args)
      },
      serial<K extends EventName>(name: K, ...args: EventArgs<K>): Promise<Awaited<EventResult<K>> | undefined> {
        return kernel.serial(name, ...args)
      },
      bail<K extends EventName>(name: K, ...args: EventArgs<K>): EventResult<K> | undefined {
        return kernel.bail(name, ...args)
      },
      waterfall<K extends EventName>(name: K, ...args: EventArgs<K>): EventResult<K> {
        return kernel.waterfall(name, ...args)
      },
    }

    try {
      const cleanup = plugin.activate(context)
      if (cleanup) mounted.cleanups.push(cleanup)
      mounted.status = 'active'
    } catch (error) {
      this.#runImmediateCleanups(mounted)
      mounted.status = 'pending'
      throw error
    }
  }

  #listen(owner: string, name: PropertyKey, callback: EventListener, options: EventOptions): Cleanup {
    let listeners = this.#listeners.get(name)
    if (!listeners) {
      listeners = []
      this.#listeners.set(name, listeners)
    }
    const record = { owner, callback }
    if (options.prepend) listeners.unshift(record)
    else listeners.push(record)
    let active = true
    return () => {
      if (!active) return
      active = false
      const index = listeners?.indexOf(record) ?? -1
      if (index >= 0) listeners?.splice(index, 1)
      if (listeners?.length === 0) this.#listeners.delete(name)
    }
  }

  #eventListeners(name: PropertyKey): EventListener[] {
    return (this.#listeners.get(name) ?? []).map((record) => record.callback)
  }

  async #unmount(mounted: MountedPlugin): Promise<void> {
    if (!this.#mounted.includes(mounted)) return
    const errors: unknown[] = []
    try {
      await this.#deactivateDependents(mounted.plugin.id)
    } catch (error) {
      errors.push(error)
    }
    try {
      await this.#deactivate(mounted)
    } catch (error) {
      errors.push(error)
    }
    const index = this.#mounted.indexOf(mounted)
    if (index >= 0) this.#mounted.splice(index, 1)
    if (!this.#disposed) {
      try {
        this.#reconcile()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Failed to unload plugin tree: ${mounted.plugin.id}`)
  }

  async #deactivateDependents(owner: string): Promise<void> {
    const serviceKeys = new Set(
      [...this.#services.entries()]
        .filter(([, record]) => record.owner === owner)
        .map(([key]) => key),
    )
    if (serviceKeys.size === 0) return
    const dependents = this.#mounted.filter((candidate) => (
      candidate.status === 'active'
      && candidate.plugin.id !== owner
      && (candidate.plugin.requires ?? []).some((token) => serviceKeys.has(token.key))
    ))
    const errors: unknown[] = []
    for (const dependent of dependents.reverse()) {
      try {
        await this.#deactivateDependents(dependent.plugin.id)
      } catch (error) {
        errors.push(error)
      }
      try {
        await this.#deactivate(dependent)
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length > 0) throw new AggregateError(errors, `Failed to suspend dependents of: ${owner}`)
  }

  async #deactivate(mounted: MountedPlugin): Promise<void> {
    if (mounted.status === 'pending') return
    mounted.status = 'deactivating'
    const errors: unknown[] = []
    for (const cleanup of [...mounted.cleanups].reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    mounted.cleanups.length = 0
    mounted.status = 'pending'
    if (errors.length > 0) throw new AggregateError(errors, `Failed to unload plugin: ${mounted.plugin.id}`)
  }

  #removeImmediately(mounted: MountedPlugin): void {
    this.#deactivateDependentsImmediately(mounted.plugin.id)
    this.#runImmediateCleanups(mounted)
    const index = this.#mounted.indexOf(mounted)
    if (index >= 0) this.#mounted.splice(index, 1)
  }

  #deactivateDependentsImmediately(owner: string): void {
    const serviceKeys = new Set(
      [...this.#services.entries()]
        .filter(([, record]) => record.owner === owner)
        .map(([key]) => key),
    )
    for (const dependent of [...this.#mounted].reverse()) {
      if (
        dependent.status !== 'active'
        || dependent.plugin.id === owner
        || !(dependent.plugin.requires ?? []).some((token) => serviceKeys.has(token.key))
      ) continue
      this.#deactivateDependentsImmediately(dependent.plugin.id)
      this.#runImmediateCleanups(dependent)
      dependent.status = 'pending'
    }
  }

  #runImmediateCleanups(mounted: MountedPlugin): void {
    for (const cleanup of [...mounted.cleanups].reverse()) {
      try {
        const result = cleanup()
        if (result) void result.catch(() => undefined)
      } catch {
        // Preserve the activation error; asynchronous teardown is best-effort here.
      }
    }
    mounted.cleanups.length = 0
  }
}

function isBailed(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false
}
