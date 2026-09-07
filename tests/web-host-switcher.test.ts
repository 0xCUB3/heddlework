import { describe, expect, it } from 'bun:test'
import type { HostIdentity } from '../src/protocol/host-identity.ts'
import { memorySavedHostsBackend, SavedHostsStore } from '../src/client/saved-hosts.ts'
import { connectHostCards, formatConnectLastSeen } from '../src/web/connect-page.tsx'
import { WebHostSwitcher, type WebHostClient } from '../src/web/host-switcher.ts'

const studio: HostIdentity = { id: 'studio-id', name: 'Studio', os: 'darwin', arch: 'arm64', machine: 'mac-studio', version: '1', protocol: 1 }

function memoryStorage(initial: Record<string, string> = {}): Pick<Storage, 'getItem' | 'setItem'> & { dump(): Record<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, String(value)) },
    dump: () => Object.fromEntries(data),
  }
}

class FakeClient implements WebHostClient {
  readonly connectCalls: Array<[string, string, readonly string[] | undefined]> = []
  candidates: readonly string[] = []
  #listeners = new Set<() => void>()
  #view: ReturnType<WebHostClient['getSnapshot']> = { status: 'closed', workspacePath: '' }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  getSnapshot(): ReturnType<WebHostClient['getSnapshot']> {
    return this.#view
  }

  connect(url: string, token: string, alternates: readonly string[] = []): void {
    this.connectCalls.push([url, token, alternates])
    this.candidates = [url, ...alternates.filter((entry) => entry !== url)]
    this.#view = { status: 'connecting', url, workspacePath: this.#view.workspacePath }
    this.#emit()
  }

  open(patch: { host?: HostIdentity | undefined; url?: string | undefined; workspacePath?: string | undefined }): void {
    this.#view = {
      status: 'open',
      url: patch.url ?? this.#view.url,
      workspacePath: patch.workspacePath ?? '/repo',
      ...(patch.host ? { host: patch.host } : this.#view.host ? { host: this.#view.host } : {}),
    }
    this.#emit()
  }

  #emit(): void {
    for (const listener of this.#listeners) listener()
  }
}

describe('WebHostSwitcher', () => {
  it('connect(link) writes storage and calls client.connect with the parsed url/token', async () => {
    const client = new FakeClient()
    const storage = memoryStorage()
    const switcher = new WebHostSwitcher(client, storage)
    await switcher.connect({ link: 'http://studio.local:4817/?token=abc' })
    expect(storage.dump()).toMatchObject({ 'heddlework.host': 'http://studio.local:4817', 'heddlework.token': 'abc' })
    expect(client.connectCalls).toEqual([['http://studio.local:4817', 'abc', []]])
    expect(switcher.getSnapshot()).toMatchObject({
      current: { origin: 'remote', url: 'http://studio.local:4817', status: 'connecting' },
      busy: true,
      canUseLocal: false,
    })
  })

  it('remembers the host when the client opens with an identity', async () => {
    const client = new FakeClient()
    const storage = memoryStorage()
    const saved = new SavedHostsStore(memorySavedHostsBackend())
    const switcher = new WebHostSwitcher(client, storage, saved)
    await switcher.connect({ link: 'http://studio.local:4817/?token=abc' })
    client.candidates = ['http://studio.local:4817', 'http://100.64.0.2:4817']
    client.open({ host: studio, url: 'http://studio.local:4817', workspacePath: '/repo' })
    expect(saved.list()).toHaveLength(1)
    expect(saved.list()[0]).toMatchObject({
      id: 'studio-id',
      name: 'Studio',
      url: 'http://studio.local:4817',
      token: 'abc',
      lastWorkspacePath: '/repo',
      machine: 'mac-studio',
    })
    expect(saved.list()[0]?.hostUrls).toEqual(['http://studio.local:4817', 'http://100.64.0.2:4817'])
    expect(switcher.getSnapshot().busy).toBe(false)
    expect(switcher.getSnapshot().current.identity).toEqual(studio)
    expect(storage.dump()['heddlework.hostUrls']).toBe(JSON.stringify(['http://studio.local:4817', 'http://100.64.0.2:4817']))
  })

  it('connect(savedId) uses the row url/token and hostUrls as alternates', async () => {
    const client = new FakeClient()
    const storage = memoryStorage()
    const saved = new SavedHostsStore(memorySavedHostsBackend())
    saved.remember({
      url: 'http://studio.local:4817',
      token: 'saved-token',
      hostUrls: ['http://studio.local:4817', 'http://100.64.0.2:4817'],
      identity: studio,
      now: 10,
    })
    const switcher = new WebHostSwitcher(client, storage, saved)
    await switcher.connect({ savedId: 'studio-id' })
    expect(client.connectCalls).toEqual([['http://studio.local:4817', 'saved-token', ['http://studio.local:4817', 'http://100.64.0.2:4817']]])
    expect(storage.dump()).toMatchObject({ 'heddlework.host': 'http://studio.local:4817', 'heddlework.token': 'saved-token' })
  })

  it('connect(link) passes hostUrls from a matching saved row as alternates', async () => {
    const client = new FakeClient()
    const storage = memoryStorage()
    const saved = new SavedHostsStore(memorySavedHostsBackend())
    saved.remember({
      url: 'http://studio.local:4817',
      token: 'old',
      hostUrls: ['http://studio.local:4817', 'http://100.64.0.2:4817'],
      identity: studio,
      now: 10,
    })
    const switcher = new WebHostSwitcher(client, storage, saved)
    await switcher.connect({ link: 'http://studio.local:4817/?token=new' })
    expect(client.connectCalls[0]?.[2]).toEqual(['http://studio.local:4817', 'http://100.64.0.2:4817'])
  })

  it('useLocal rejects', async () => {
    const switcher = new WebHostSwitcher(new FakeClient(), memoryStorage())
    expect(switcher.getSnapshot().canUseLocal).toBe(false)
    await expect(switcher.useLocal()).rejects.toThrow('This browser has no local runtime')
  })

  it('rejects an invalid link and does not touch storage', async () => {
    const client = new FakeClient()
    const storage = memoryStorage()
    const switcher = new WebHostSwitcher(client, storage)
    await expect(switcher.connect({ link: 'not a url' })).rejects.toThrow('Invalid connect link')
    await expect(switcher.connect({ link: 'http://studio.local:4817/' })).rejects.toThrow('Invalid connect link')
    expect(storage.dump()).toEqual({})
    expect(client.connectCalls).toEqual([])
  })

  it('forget and rename delegate to the store', () => {
    const saved = new SavedHostsStore(memorySavedHostsBackend())
    saved.remember({ url: 'http://studio.local:4817', token: 'abc', identity: studio, now: 10 })
    const switcher = new WebHostSwitcher(new FakeClient(), memoryStorage(), saved)
    switcher.rename('studio-id', 'Bench')
    expect(saved.get('studio-id')?.name).toBe('Bench')
    switcher.forget('studio-id')
    expect(saved.list()).toEqual([])
  })
})

describe('connectHostCards', () => {
  it('builds machine kind, name, last seen, and url host', () => {
    const now = 1_700_000_000_000
    expect(formatConnectLastSeen(now - 5 * 60_000, now)).toBe('5m ago')
    expect(formatConnectLastSeen(0, now)).toBe('Never')
    const cards = connectHostCards([
      {
        id: 'studio-id',
        name: 'Studio',
        url: 'http://studio.local:4817',
        token: 't',
        hostUrls: [],
        machine: 'mac-studio',
        os: 'darwin',
        lastSeenAt: now - 2 * 60 * 60_000,
      },
    ], now)
    expect(cards).toEqual([
      { id: 'studio-id', name: 'Studio', machineLabel: 'Mac Studio', lastSeen: '2h ago', urlHost: 'studio.local' },
    ])
  })
})
