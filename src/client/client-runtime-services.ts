import { isBrowserIntegrationCommand, type BrowserIntegrationCommand, type BrowserIntegrationSnapshot } from '../browser/integration-types.ts'
import type { BrowserIntegrationService } from '../browser/integrations.ts'
import { DEFAULT_SLEEP_PREVENTION_POLICY, parseSleepPreventionPolicy, type SleepPreventionPolicy, type SleepPreventionSnapshot } from '../power/types.ts'
import type { SleepPreventionService } from '../power/service.ts'
import type { WorkspaceClient } from '../web/client.ts'

export function createClientBrowserIntegrationService(client: WorkspaceClient): BrowserIntegrationService {
  const listeners = new Set<() => void>()
  let snapshot: BrowserIntegrationSnapshot = {
    choices: [{ id: 'builtin', label: 'Built-in browser', available: true, description: 'Native GPUIX browser on this device.' }],
    selectedId: 'builtin',
    profile: '',
    task: null,
    error: null,
  }

  const pull = (): void => {
    const next = client.getSnapshot().browserIntegrations
    if (next) snapshot = next
  }
  pull()
  const unsubscribe = client.subscribe(() => {
    pull()
    for (const listener of listeners) listener()
  })

  const service: BrowserIntegrationService = {
    getSnapshot: () => snapshot,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispatch: (command: BrowserIntegrationCommand) => {
      if (!isBrowserIntegrationCommand(command)) throw new Error('Invalid browser integration command')
      void client.send(command).catch((error: unknown) => {
        snapshot = { ...snapshot, error: error instanceof Error ? error.message : String(error) }
        for (const listener of listeners) listener()
      })
    },
    dispose: () => { unsubscribe(); listeners.clear() },
  } as BrowserIntegrationService

  return service
}

export function createClientSleepPreventionService(client: WorkspaceClient): SleepPreventionService {
  const listeners = new Set<() => void>()
  let snapshot: SleepPreventionSnapshot = {
    status: 'idle',
    policy: DEFAULT_SLEEP_PREVENTION_POLICY,
    inhibiting: false,
    displaySupported: false,
    platform: 'other',
    backend: 'none',
    reason: '',
    limits: '',
  }

  const pull = (): void => {
    const next = client.getSnapshot().sleepPrevention
    if (next) snapshot = next
  }
  pull()
  const unsubscribe = client.subscribe(() => {
    pull()
    for (const listener of listeners) listener()
  })

  const service: SleepPreventionService = {
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    getSnapshot: () => snapshot,
    setPolicy: (policy: SleepPreventionPolicy) => {
      const parsed = parseSleepPreventionPolicy(policy)
      snapshot = { ...snapshot, policy: parsed }
      for (const listener of listeners) listener()
      void client.send({ type: 'setSleepPreventionPolicy', when: parsed.when, keepDisplayAwake: parsed.keepDisplayAwake }).catch(() => undefined)
    },
    dispose: async () => { unsubscribe(); listeners.clear() },
  } as SleepPreventionService

  return service
}


