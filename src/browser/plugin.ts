import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { browserDataRoot, browserStatePath } from './persistence.ts'
import { BrowserSessionService } from './service.ts'

export const browserSessionToken = serviceToken<BrowserSessionService>('browser-session')

export function createBrowserPlugin(options: {
  statePath?: string | false
  dataRoot?: string
  cleanupOrphanedProfiles?: boolean
} = {}): WorkbenchPlugin {
  return {
    id: 'browser-session',
    activate(ctx) {
      const service = new BrowserSessionService({
        statePath: options.statePath ?? browserStatePath(),
        dataRoot: options.dataRoot ?? browserDataRoot(),
        cleanupOrphanedProfiles: options.cleanupOrphanedProfiles ?? true,
      })
      ctx.provide(browserSessionToken, service)
      ctx.effect(() => () => service.dispose())
    },
  }
}
