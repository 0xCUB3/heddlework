import type { ComponentType } from 'react'
import { serviceToken, type Cleanup, type WorkbenchPlugin } from '../core/kernel.ts'
import type { IconName } from './icons.tsx'
import type { ResolvedTheme } from './theme.ts'

export interface WorkbenchSurfaceProps {
  fullscreen: boolean
  fullscreenProgress: number
  fullscreenLocked?: boolean
  panelWidth: number
  appearance?: ResolvedTheme
  onToggleFullscreen(): void
  onNewSurface(): void
  onClose(): void
}

export interface WorkbenchSurfaceContribution {
  id: string
  title: string
  description: string
  icon: IconName
  order?: number
  component: ComponentType<WorkbenchSurfaceProps>
  onOpen?(): void
}

export interface WorkbenchUiExtension {
  id: string
  surfaces?: readonly WorkbenchSurfaceContribution[]
}

export interface RegisteredWorkbenchSurface extends WorkbenchSurfaceContribution {
  extensionId: string
}

export interface WorkbenchUiSnapshot {
  surfaces: readonly RegisteredWorkbenchSurface[]
}

const EMPTY_SNAPSHOT: WorkbenchUiSnapshot = { surfaces: [] }

export class WorkbenchUiRegistry {
  readonly #extensions = new Map<string, WorkbenchUiExtension>()
  readonly #listeners = new Set<() => void>()
  #snapshot = EMPTY_SNAPSHOT

  readonly subscribe = (listener: () => void): Cleanup => {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  readonly getSnapshot = (): WorkbenchUiSnapshot => this.#snapshot

  register(extension: WorkbenchUiExtension): Cleanup {
    const extensionId = extension.id.trim()
    if (!extensionId) throw new Error('UI extension id must not be empty')
    if (this.#extensions.has(extensionId)) throw new Error(`UI extension already registered: ${extensionId}`)

    const localIds = new Set<string>()
    const occupiedIds = new Set(this.#snapshot.surfaces.map((surface) => surface.id))
    for (const surface of extension.surfaces ?? []) {
      const id = surface.id.trim()
      if (!id) throw new Error(`UI surface id must not be empty: ${extensionId}`)
      if (localIds.has(id)) throw new Error(`UI surface registered twice by ${extensionId}: ${id}`)
      if (occupiedIds.has(id)) throw new Error(`UI surface already registered: ${id}`)
      localIds.add(id)
    }

    const registered = extensionId === extension.id ? extension : { ...extension, id: extensionId }
    this.#extensions.set(extensionId, registered)
    this.#publish()
    let active = true
    return () => {
      if (!active) return
      active = false
      if (this.#extensions.get(extensionId) !== registered) return
      this.#extensions.delete(extensionId)
      this.#publish()
    }
  }

  dispose(): void {
    if (this.#extensions.size === 0 && this.#listeners.size === 0) return
    this.#extensions.clear()
    this.#publish()
    this.#listeners.clear()
  }

  #publish(): void {
    const surfaces = [...this.#extensions.values()]
      .flatMap((extension) => (extension.surfaces ?? []).map((surface): RegisteredWorkbenchSurface => ({
        ...surface,
        id: surface.id.trim(),
        extensionId: extension.id,
      })))
      .sort((left, right) => (left.order ?? 100) - (right.order ?? 100) || left.title.localeCompare(right.title) || left.id.localeCompare(right.id))
    this.#snapshot = { surfaces }
    for (const listener of this.#listeners) listener()
  }
}

export const workbenchUiRegistryToken = serviceToken<WorkbenchUiRegistry>('workbench-ui-registry')

export const workbenchUiHostPlugin: WorkbenchPlugin = {
  id: 'workbench-ui-host',
  activate(ctx) {
    const registry = new WorkbenchUiRegistry()
    ctx.provide(workbenchUiRegistryToken, registry)
    ctx.effect(() => () => registry.dispose())
  },
}
