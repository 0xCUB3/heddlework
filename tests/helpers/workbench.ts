import { PiSessionCatalog } from '../../src/pi/session-catalog.ts'
import type { WorkbenchController, WorkbenchControllerDependencies } from '../../src/workbench/controller.ts'
import type { SessionCatalogService } from '../../src/workbench/services.ts'
import { loadWorkspaceDiff } from '../../src/workspace/git-diff.ts'
import { createCoreUiExtension } from '../../src/ui/core-extension.tsx'
import { WorkbenchUiRegistry } from '../../src/ui/extensions.ts'

export function testControllerDependencies(sessionCatalog: SessionCatalogService = new PiSessionCatalog({ scope: 'cwd' })): WorkbenchControllerDependencies {
  return {
    sessionCatalog,
    workspaceDiff: { load: loadWorkspaceDiff },
  }
}

export function createTestUiRegistry(controller: WorkbenchController): WorkbenchUiRegistry {
  const registry = new WorkbenchUiRegistry()
  registry.register(createCoreUiExtension(controller))
  return registry
}
