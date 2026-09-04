import { createRoot } from 'react-dom/client'
import { WebApp } from './app.tsx'
import { readConnectionSettings, workspaceClient } from './store.ts'

const settings = readConnectionSettings(location.search, localStorage, location.origin)
if (settings.host) localStorage.setItem('heddlework.host', settings.host)
if (settings.token) localStorage.setItem('heddlework.token', settings.token)
if (settings.host && settings.token) workspaceClient().connect(settings.host, settings.token)

if ('serviceWorker' in navigator) {
  void navigator.serviceWorker.register('/sw.js')
}

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root')
createRoot(root).render(<WebApp />)
