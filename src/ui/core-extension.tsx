import type { WorkbenchPlugin } from '../core/kernel.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { workbenchUiRegistryToken } from './extensions.ts'
import { createCoreUiExtension } from './core-extension-surfaces.tsx'

export { createCoreUiExtension } from './core-extension-surfaces.tsx'

export function createCoreUiExtensionPlugin(): WorkbenchPlugin {
  return {
    id: 'core-workbench-ui',
    requires: [workbenchUiRegistryToken, workbenchControllerToken],
    activate(ctx) {
      const registry = ctx.get(workbenchUiRegistryToken)
      const controller = ctx.get(workbenchControllerToken)
      ctx.effect(() => registry.register(createCoreUiExtension(controller)))
    },
  }
}

