import React, { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { TerminalServiceSnapshot } from '../terminal/types.ts'

const TerminalServiceContext = createContext<TerminalSessionService | undefined>(undefined)

export function TerminalServiceProvider({
  service,
  children,
}: {
  service?: TerminalSessionService | undefined
  children: React.ReactNode
}) {
  return <TerminalServiceContext.Provider value={service}>{children}</TerminalServiceContext.Provider>
}

export function useOptionalTerminalService(): TerminalSessionService | undefined {
  return useContext(TerminalServiceContext)
}

const TerminalProjectionSuspensionContext = createContext(false)

export function TerminalProjectionSuspensionProvider({
  suspended,
  children,
}: {
  suspended: boolean
  children: React.ReactNode
}) {
  return <TerminalProjectionSuspensionContext.Provider value={suspended}>{children}</TerminalProjectionSuspensionContext.Provider>
}

export function useTerminalProjectionSuspended(): boolean {
  return useContext(TerminalProjectionSuspensionContext)
}

export function useTerminalServiceSnapshot(
  service: TerminalSessionService,
  suspended = false,
): TerminalServiceSnapshot {
  const retained = useRef(service.getSnapshot())
  if (!suspended) retained.current = service.getSnapshot()
  const getSnapshot = useCallback(
    () => suspended ? retained.current : service.getSnapshot(),
    [service, suspended],
  )
  return useSyncExternalStore(service.subscribe, getSnapshot, getSnapshot)
}
