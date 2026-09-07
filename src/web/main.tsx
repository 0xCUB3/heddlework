import '../dom/process-shim.ts'
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { installCreateElementBridge } from '../dom/host.tsx'
import { WebWorkbench } from './workbench.tsx'
import { ConnectPage } from './connect-page.tsx'
import { isNativeShell } from './native-shell.ts'
import { readConnectionSettings, workspaceClient } from './store.ts'

installCreateElementBridge()

const settings = readConnectionSettings(location.search, localStorage, location.origin)
const hasCredentials = Boolean(settings.host && settings.token)
if (hasCredentials) {
  localStorage.setItem('heddlework.host', settings.host)
  localStorage.setItem('heddlework.token', settings.token)
  workspaceClient().connect(settings.host, settings.token, readStoredAlternates(localStorage))
}

function readStoredAlternates(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem('heddlework.hostUrls') ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

function Root() {
  const [session, setSession] = useState(hasCredentials)
  if (!session) return <ConnectPage onConnected={() => setSession(true)} />
  return <WebWorkbench />
}

if ('serviceWorker' in navigator && !isNativeShell()) {
  void navigator.serviceWorker.register('/sw.js')
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(<Root />)
