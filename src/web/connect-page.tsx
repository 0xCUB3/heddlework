/** @jsxImportSource react */
// First-run / forgotten-host screen. Real DOM so it can use styles.css; the workbench stays on the gpuix tree.

import { useMemo, useState, useSyncExternalStore } from 'react'
import { hostMachineLabel } from '../protocol/host-identity.ts'
import { hostLabelFromUrl, type SavedHost } from '../client/saved-hosts.ts'
import { workspaceClient } from './store.ts'
import { WebHostSwitcher, type WebHostClient } from './host-switcher.ts'

export function formatConnectLastSeen(timestamp: number, now = Date.now()): string {
  if (!timestamp) return 'Never'
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000)
  if (minutes < 1) return 'Just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export interface ConnectHostCard {
  id: string
  name: string
  machineLabel: string
  lastSeen: string
  urlHost: string
}

export function connectHostCards(hosts: readonly SavedHost[], now = Date.now()): ConnectHostCard[] {
  return hosts.map((host) => ({
    id: host.id,
    name: host.name,
    machineLabel: hostMachineLabel(host.machine),
    lastSeen: formatConnectLastSeen(host.lastSeenAt, now),
    urlHost: hostLabelFromUrl(host.url),
  }))
}

export function ConnectPage({
  onConnected,
  storage = localStorage,
  client = workspaceClient(),
}: {
  onConnected: () => void
  storage?: Pick<Storage, 'getItem' | 'setItem'>
  client?: WebHostClient
}) {
  const switcher = useMemo(() => new WebHostSwitcher(client, storage), [client, storage])
  const snapshot = useSyncExternalStore(switcher.subscribe.bind(switcher), switcher.getSnapshot.bind(switcher), switcher.getSnapshot.bind(switcher))
  const cards = connectHostCards(snapshot.saved)
  const [link, setLink] = useState('')
  const [error, setError] = useState('')

  async function connectLink(): Promise<void> {
    setError('')
    try {
      await switcher.connect({ link })
      onConnected()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  async function connectSaved(savedId: string): Promise<void> {
    setError('')
    try {
      await switcher.connect({ savedId })
      onConnected()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  return (
    <div className="connect-page" data-testid="web-connect-page">
      <div className="connect-shell">
        <p className="connect-kicker">Heddlework remote</p>
        <h1 className="connect-title">Connect to a computer</h1>
        <p className="connect-lead">Paste a connect link from the host, or pick a machine you have used before.</p>
        {cards.length > 0 ? (
          <div className="connect-hosts" data-testid="connect-hosts">
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="connect-host"
                data-testid={`connect-host-${card.id}`}
                onClick={() => { void connectSaved(card.id) }}
              >
                <span className="connect-host-kind">{card.machineLabel}</span>
                <span className="connect-host-name">{card.name}</span>
                <span className="connect-host-meta">{card.lastSeen} · {card.urlHost}</span>
              </button>
            ))}
          </div>
        ) : null}
        <form
          className="connect-form"
          onSubmit={(event) => {
            event.preventDefault()
            void connectLink()
          }}
        >
          <textarea
            className="connect-input"
            data-testid="connect-link-input"
            value={link}
            rows={3}
            placeholder="http://studio.local:4817/?token=…"
            onChange={(event) => setLink(event.target.value)}
          />
          <button type="submit" className="connect-submit" data-testid="connect-submit">Connect</button>
        </form>
        {error ? <p className="connect-error" data-testid="connect-error">{error}</p> : null}
      </div>
    </div>
  )
}
