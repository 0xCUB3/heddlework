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

interface MountedPlugin {
  id: string
  cleanups: Cleanup[]
}

export class WorkbenchKernel {
  readonly #services = new Map<symbol, { owner: string; value: unknown }>()
  readonly #contributions = new Map<symbol, Map<string, Contribution[]>>()
  readonly #mounted: MountedPlugin[] = []
  #activeOwner: string | undefined
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
    if (this.#mounted.some((entry) => entry.id === plugin.id)) {
      throw new Error(`Plugin already mounted: ${plugin.id}`)
    }
    for (const required of plugin.requires ?? []) this.get(required)

    const mounted: MountedPlugin = { id: plugin.id, cleanups: [] }
    const context: PluginContext = {
      get: <T>(token: ServiceToken<T>) => this.get(token),
      provide: <T>(token: ServiceToken<T>, value: T) => {
        if (this.#services.has(token.key)) throw new Error(`Service already provided: ${token.name}`)
        this.#services.set(token.key, { owner: plugin.id, value })
        mounted.cleanups.push(() => {
          const current = this.#services.get(token.key)
          if (current?.owner === plugin.id) this.#services.delete(token.key)
        })
      },
      effect: (setup) => {
        const cleanup = setup()
        if (cleanup) mounted.cleanups.push(cleanup)
      },
      contribute: <T>(slot: SlotToken<T>, key: string, value: T) => {
        let keyed = this.#contributions.get(slot.key)
        if (!keyed) {
          keyed = new Map()
          this.#contributions.set(slot.key, keyed)
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
          if (keyed?.size === 0) this.#contributions.delete(slot.key)
        })
      },
    }

    this.#activeOwner = plugin.id
    try {
      const cleanup = plugin.activate(context)
      if (cleanup) mounted.cleanups.push(cleanup)
      this.#mounted.push(mounted)
    } catch (error) {
      for (const cleanup of mounted.cleanups.reverse()) void cleanup()
      throw error
    } finally {
      this.#activeOwner = undefined
    }

    return async () => this.#unmount(mounted)
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return
    this.#disposed = true
    for (const mounted of [...this.#mounted].reverse()) await this.#unmount(mounted)
  }

  async #unmount(mounted: MountedPlugin): Promise<void> {
    const index = this.#mounted.indexOf(mounted)
    if (index >= 0) this.#mounted.splice(index, 1)
    const errors: unknown[] = []
    for (const cleanup of [...mounted.cleanups].reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    mounted.cleanups.length = 0
    if (errors.length > 0) throw new AggregateError(errors, `Failed to unload plugin: ${mounted.id}`)
  }
}
