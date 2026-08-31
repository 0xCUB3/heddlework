import React, { createContext, useContext } from 'react'
import type { TerminalSessionService } from '../terminal/service.ts'

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
