import '../dom/process-shim.ts'
import { createRoot } from 'react-dom/client'
import { installCreateElementBridge } from '../dom/host.tsx'
import { WebWorkbench } from './workbench.tsx'
import { isNativeShell } from './native-shell.ts'
import { readConnectionSettings, workspaceClient } from './store.ts'

installCreateElementBridge()

const settings = readConnectionSettings(location.search, localStorage, location.origin)
if (settings.host) localStorage.setItem('heddlework.host', settings.host)
if (settings.token) localStorage.setItem('heddlework.token', settings.token)
if (settings.host && settings.token) {
  const client = workspaceClient()
  client.connect(settings.host, settings.token, readStoredAlternates(localStorage))
  // Remember every address the host advertises so a later launch can still reach it when the first one is down.
  client.subscribe(() => {
    if (client.getSnapshot().status === 'open') localStorage.setItem('heddlework.hostUrls', JSON.stringify(client.candidates))
  })
}

function readStoredAlternates(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const parsed: unknown = JSON.parse(storage.getItem('heddlework.hostUrls') ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : []
  } catch {
    return []
  }
}

if ('serviceWorker' in navigator && !isNativeShell()) {
  void navigator.serviceWorker.register('/sw.js')
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(<WebWorkbench />)
