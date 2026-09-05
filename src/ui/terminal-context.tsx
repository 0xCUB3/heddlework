import React, { createContext, useCallback, useContext, useRef, useSyncExternalStore } from 'react'
import type { TerminalSessionService } from '../terminal/service.ts'
import type { TerminalGridSnapshot, TerminalServiceSnapshot, TerminalSessionId } from '../terminal/types.ts'

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
  const retained = useRef(service.getStateSnapshot())
  if (!suspended) retained.current = service.getStateSnapshot()
  const getSnapshot = useCallback(
    () => suspended ? retained.current : service.getStateSnapshot(),
    [service, suspended],
  )
  return useSyncExternalStore(service.subscribeState, getSnapshot, getSnapshot)
}

export function useTerminalGrid(
  service: TerminalSessionService,
  sessionId: TerminalSessionId | undefined,
  suspended = false,
): TerminalGridSnapshot | undefined {
  const retained = useRef<{ service: TerminalSessionService; id: TerminalSessionId | undefined; grid: TerminalGridSnapshot | undefined }>({
    service,
    id: sessionId,
    grid: service.grid(sessionId),
  })
  if (retained.current.service !== service || retained.current.id !== sessionId) {
    retained.current = { service, id: sessionId, grid: service.grid(sessionId) }
  } else if (!suspended) {
    retained.current.grid = service.grid(sessionId)
  }
  const subscribe = useCallback((listener: () => void) => {
    if (suspended || !sessionId) return () => {}
    return service.subscribeFrames((changedId) => {
      if (changedId === sessionId) listener()
    })
  }, [service, sessionId, suspended])
  const getSnapshot = useCallback(
    () => suspended ? retained.current.grid : service.grid(sessionId),
    [service, sessionId, suspended],
  )
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
