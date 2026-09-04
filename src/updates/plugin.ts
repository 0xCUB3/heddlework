import type { WorkbenchPlugin } from '../core/kernel.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { checkForUpdate, type UpdateCheckOptions } from './check.ts'
import { currentAppVersion } from './version.ts'

export interface UpdateCheckPluginOptions extends Partial<UpdateCheckOptions> {
  enabled?: boolean | undefined
  delayMs?: number | undefined
}

// Posts one notice with the release page when a newer tag exists. Installing the update stays a manual step.
export function createUpdateCheckPlugin(options: UpdateCheckPluginOptions = {}): WorkbenchPlugin {
  return {
    id: 'update-check',
    requires: [workbenchControllerToken],
    activate(ctx) {
      const enabled = options.enabled ?? process.env.HEDDLEWORK_UPDATE_CHECK !== '0'
      if (!enabled) return
      const controller = ctx.get(workbenchControllerToken)
      const currentVersion = options.currentVersion ?? currentAppVersion()
      let cancelled = false
      const timer = setTimeout(() => {
        void checkForUpdate({ ...options, currentVersion }).then((result) => {
          if (cancelled || !result.available) return
          controller.notify('info', `Heddlework ${result.version} is available (running ${currentVersion}). Download: ${result.url ?? 'https://github.com/0xCUB3/heddlework/releases'}`)
        })
      }, options.delayMs ?? 10_000)
      timer.unref?.()
      ctx.effect(() => () => {
        cancelled = true
        clearTimeout(timer)
      })
    },
  }
}
