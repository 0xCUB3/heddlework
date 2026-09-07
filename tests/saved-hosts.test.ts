import { describe, expect, it } from 'bun:test'
import { parseConnectLink } from '../src/client/host-switcher.ts'
import { memorySavedHostsBackend, restoreSavedHosts, SavedHostsStore, savedHostIdForUrl } from '../src/client/saved-hosts.ts'
import type { HostIdentity } from '../src/protocol/host-identity.ts'

const studio: HostIdentity = { id: 'studio-id', name: 'Studio', os: 'darwin', arch: 'arm64', machine: 'mac-studio', version: '1', protocol: 1 }

describe('parseConnectLink', () => {
  it('accepts host links, socket urls, and the deep link wrapper', () => {
    expect(parseConnectLink('http://100.64.0.2:4817/?token=abc')).toEqual({ url: 'http://100.64.0.2:4817', token: 'abc' })
    expect(parseConnectLink('wss://studio.tail.ts.net/ws?token=abc')).toEqual({ url: 'https://studio.tail.ts.net', token: 'abc' })
    expect(parseConnectLink('heddlework://connect?url=' + encodeURIComponent('http://studio.local:4817/?token=t0k'))).toEqual({ url: 'http://studio.local:4817', token: 't0k' })
  })
  it('rejects links without a token or with a foreign scheme', () => {
    expect(parseConnectLink('http://studio.local:4817/')).toBeUndefined()
    expect(parseConnectLink('ftp://x/?token=a')).toBeUndefined()
    expect(parseConnectLink('not a url')).toBeUndefined()
  })
})

describe('SavedHostsStore', () => {
  it('remembers by identity, merges a url-only row, and keeps custom names', () => {
    const backend = memorySavedHostsBackend()
    const store = new SavedHostsStore(backend)
    const first = store.remember({ url: 'http://studio.local:4817', token: 'a', now: 10 })
    expect(first.id).toBe(savedHostIdForUrl('http://studio.local:4817'))
    expect(first.name).toBe('studio.local')
    const second = store.remember({ url: 'http://studio.local:4817', token: 'a', identity: studio, hostUrls: ['http://100.64.0.2:4817'], workspacePath: '/repo', now: 20 })
    expect(store.list()).toHaveLength(1)
    expect(second).toMatchObject({ id: 'studio-id', name: 'Studio', machine: 'mac-studio', os: 'darwin', lastWorkspacePath: '/repo' })
    expect(second.hostUrls).toEqual(['http://studio.local:4817', 'http://100.64.0.2:4817'])
    store.rename('studio-id', '  Bench  box ')
    store.remember({ url: 'http://studio.local:4817', token: 'a', identity: studio, now: 30 })
    expect(store.get('studio-id')?.name).toBe('Bench box')
    expect(restoreSavedHosts(backend.read())).toEqual([...store.list()])
    store.forget('studio-id')
    expect(store.list()).toEqual([])
  })

  it('orders by recency, drops malformed rows, and caps the list', () => {
    const rows = Array.from({ length: 30 }, (_, index) => ({ id: `h${index}`, name: `Host ${index}`, url: `http://h${index}:1`, token: 't', lastSeenAt: index }))
    const restored = restoreSavedHosts({ version: 1, hosts: [...rows, { id: 'bad' }, null] })
    expect(restored).toHaveLength(24)
    expect(restored[0]?.id).toBe('h29')
    expect(restored[0]?.machine).toBe('server')
  })
})
