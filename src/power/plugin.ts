import type { BrowserIntegrationService } from '../browser/integrations.ts'
import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import type { SleepBackend } from './backends.ts'
import { SleepPreventionService } from './service.ts'

export const sleepPreventionToken = serviceToken<SleepPreventionService>('sleep-prevention')

export interface SleepPreventionPluginOptions {
  preferencePath?: string | false | undefined
  browserIntegrations?: BrowserIntegrationService | undefined
  backend?: SleepBackend | undefined
  releaseDebounceMs?: number | undefined
}

export function createSleepPreventionPlugin(options: SleepPreventionPluginOptions = {}): WorkbenchPlugin {
  return {
    id: 'sleep-prevention',
    requires: [workbenchControllerToken],
    activate(ctx) {
      const service = new SleepPreventionService({
        controller: ctx.get(workbenchControllerToken),
        ...(options.browserIntegrations ? { browserIntegrations: options.browserIntegrations } : {}),
        preferencePath: options.preferencePath ?? false,
        ...(options.backend ? { backend: options.backend } : {}),
        ...(options.releaseDebounceMs !== undefined ? { releaseDebounceMs: options.releaseDebounceMs } : {}),
      })
      ctx.provide(sleepPreventionToken, service)
      ctx.effect(() => () => service.dispose())
    },
  }
}
