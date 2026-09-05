import React, { createContext, useContext, useSyncExternalStore } from 'react'
import type { BrowserSessionService } from '../browser/service.ts'
import type { BrowserSnapshot } from '../browser/types.ts'

const BrowserServiceContext = createContext<BrowserSessionService | undefined>(undefined)

export function BrowserServiceProvider({
  service,
  children,
}: {
  service?: BrowserSessionService | undefined
  children: React.ReactNode
}) {
  return <BrowserServiceContext.Provider value={service}>{children}</BrowserServiceContext.Provider>
}

export function useOptionalBrowserService(): BrowserSessionService | undefined {
  return useContext(BrowserServiceContext)
}

export function useBrowserSnapshot(service: BrowserSessionService): BrowserSnapshot {
  return useSyncExternalStore(service.subscribe, service.getSnapshot, service.getSnapshot)
}
