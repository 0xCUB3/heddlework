import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { terminalAppearancePreferencePath } from './appearance.ts'
import { BunPtyBackend, MemoryTerminalBackend, type TerminalBackend } from './backend.ts'
import { TerminalSessionService } from './service.ts'
import type { TerminalAppearance } from './types.ts'

export const terminalSessionToken = serviceToken<TerminalSessionService>('terminal-session')

export function createTerminalPlugin(options: {
  cwd: string
  backend?: 'bun' | 'memory' | TerminalBackend
  appearance?: Partial<TerminalAppearance>
  appearancePath?: string | false
}): WorkbenchPlugin {
  return {
    id: 'terminal-session',
    activate(ctx) {
      const backend = options.backend === 'memory'
        ? new MemoryTerminalBackend()
        : options.backend === 'bun' || options.backend === undefined
          ? new BunPtyBackend()
          : options.backend
      const service = new TerminalSessionService({
        cwd: options.cwd,
        backend,
        ...(options.appearance ? { appearance: options.appearance } : {}),
        appearancePath: options.appearancePath ?? terminalAppearancePreferencePath(),
      })
      ctx.provide(terminalSessionToken, service)
      ctx.effect(() => () => service.dispose())
    },
  }
}
