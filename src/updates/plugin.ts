import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'
import { workbenchControllerToken } from '../workbench/plugins.ts'
import { checkForUpdate, DEFAULT_UPDATE_REPOSITORY, type UpdateCheckOptions } from './check.ts'
import type { UpdateChannel } from './feed.ts'
import { readUpdateChannel, writeUpdateChannel } from './preferences.ts'
import { UpdateService, type UpdateServiceOptions } from './service.ts'
import { currentAppVersion } from './version.ts'

export const updateServiceToken = serviceToken<UpdateService>('update-service')

export interface UpdateCheckPluginOptions extends Partial<UpdateCheckOptions> {
  enabled?: boolean | undefined
  delayMs?: number | undefined
}

// Posts one notice with the release page when a newer tag exists. Kept for plugins that only want a notification.
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

export interface UpdatePluginOptions extends Partial<UpdateServiceOptions> {
  preferencesPath?: string | false | undefined
}

// Provides the in-place updater: polls the release feed, downloads and verifies the platform asset, and posts a notice when a restart will install it.
export function createUpdatePlugin(options: UpdatePluginOptions = {}): WorkbenchPlugin {
  return {
    id: 'updates',
    requires: [workbenchControllerToken],
    activate(ctx) {
      const controller = ctx.get(workbenchControllerToken)
      const enabled = options.enabled ?? process.env.HEDDLEWORK_UPDATE_CHECK !== '0'
      const channel: UpdateChannel = options.channel ?? readUpdateChannel(options.preferencesPath) ?? (currentAppVersion().includes('-') ? 'prerelease' : 'stable')
      const service = new UpdateService({
        ...options,
        enabled,
        channel,
        currentVersion: options.currentVersion ?? currentAppVersion(),
        repository: options.repository ?? DEFAULT_UPDATE_REPOSITORY,
        persistChannel: options.persistChannel ?? ((next) => writeUpdateChannel(next, options.preferencesPath)),
      })
      ctx.provide(updateServiceToken, service)
      let announced: string | null = null
      ctx.effect(() => service.subscribe(() => {
        const state = service.getSnapshot()
        if (state.status === 'downloaded' && state.downloadedVersion && announced !== state.downloadedVersion) {
          announced = state.downloadedVersion
          controller.notify('info', `Heddlework ${state.downloadedVersion} is downloaded. Restart from Settings to install it.`)
        } else if (state.status === 'available' && state.install.managedCommand && announced !== state.availableVersion) {
          announced = state.availableVersion
          controller.notify('info', `Heddlework ${state.availableVersion} is available. Run: ${state.install.managedCommand}`)
        }
      }))
      ctx.effect(() => {
        service.start()
        return () => service.dispose()
      })
    },
  }
}
