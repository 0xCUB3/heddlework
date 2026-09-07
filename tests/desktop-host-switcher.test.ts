import { describe, expect, it } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopHostSwitcher } from '../src/client/desktop-host-switcher.ts'
import { memorySavedHostsBackend, SavedHostsStore } from '../src/client/saved-hosts.ts'
import type { CurrentHost } from '../src/client/host-switcher.ts'
import type { RemoteClientServices, RuntimeAttachDescriptor } from '../src/client/runtime-attach.ts'
import type { HostIdentity } from '../src/protocol/host-identity.ts'
import type { WorkspaceClientView } from '../src/web/client.ts'

const studio: HostIdentity = { id: 'studio-id', name: 'Studio', os: 'darwin', arch: 'arm64', machine: 'mac-studio', version: '1', protocol: 1 }
const localDescriptor: RuntimeAttachDescriptor = { workspaceUrl: 'http://127.0.0.1:4817', token: 'local-token', controlUrl: 'http://127.0.0.1:4817' }

function fakeServices(label: string, view: Partial<WorkspaceClientView> = {}): RemoteClientServices {
  const listeners = new Set<() => void>()
  const snapshot: WorkspaceClientView = {
    status: view.status ?? 'open',
    workspacePath: view.workspacePath ?? '/repo',
    host: view.host,
    url: view.url ?? 'http://127.0.0.1:4817',
    state: undefined,
    flows: undefined,
    lastError: view.lastError,
  }
  const client = {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot() { return snapshot },
    get candidates() { return [snapshot.url ?? ''] },
    disconnect() {},
  }
  return {
    client,
    dispose: async () => { disposed.push(label) },
  } as unknown as RemoteClientServices
}

const disposed: string[] = []

describe('DesktopHostSwitcher', () => {
  function setup(options: { lastHostPath?: string | false; failRemote?: boolean } = {}) {
    disposed.length = 0
    const savedHosts = new SavedHostsStore(memorySavedHostsBackend())
    const currents: CurrentHost[] = []
    let failRemote = options.failRemote ?? false
    const switcher = new DesktopHostSwitcher({
      local: { descriptor: localDescriptor },
      savedHosts,
      lastHostPath: options.lastHostPath ?? false,
      connectTimeoutMs: 200,
      restoreTimeoutMs: 200,
      buildServices: async (descriptor) => {
        if (failRemote && descriptor.origin === 'remote') {
          failRemote = false
          throw new Error('remote unreachable')
        }
        return fakeServices(`${descriptor.origin}:${descriptor.workspaceUrl}`, {
          host: descriptor.origin === 'remote' ? studio : undefined,
          url: descriptor.workspaceUrl,
          workspacePath: '/repo',
        })
      },
      onServices(_services, current) { currents.push(current) },
    })
    return {
      switcher,
      savedHosts,
      currents,
      setFailRemote: (value: boolean) => { failRemote = value },
    }
  }

  it('rejects an invalid connect link and leaves the current host unchanged', async () => {
    const { switcher, currents } = setup()
    const local = fakeServices('local')
    await switcher.start(local)
    const before = switcher.getSnapshot().current
    await expect(switcher.connect({ link: 'not a url' })).rejects.toThrow(/Invalid connect link/)
    expect(switcher.getSnapshot().current.origin).toBe(before.origin)
    expect(switcher.getSnapshot().current.url).toBe(before.url)
    expect(disposed).toEqual([])
    expect(currents).toHaveLength(1)
  })

  it('connects from a link, remembers identity, and reports origin remote', async () => {
    const { switcher, savedHosts, currents } = setup()
    await switcher.start(fakeServices('local'))
    await switcher.connect({ link: 'http://studio.local:4817/?token=abc' })
    const snapshot = switcher.getSnapshot()
    expect(snapshot.current.origin).toBe('remote')
    expect(snapshot.current.identity).toEqual(studio)
    expect(currents.at(-1)?.origin).toBe('remote')
    expect(savedHosts.list()).toHaveLength(1)
    expect(savedHosts.list()[0]).toMatchObject({ id: 'studio-id', name: 'Studio', url: 'http://studio.local:4817', token: 'abc' })
    expect(disposed).toContain('local')
  })

  it('falls back to the previous host and rethrows when connect fails', async () => {
    const { switcher, setFailRemote } = setup()
    await switcher.start(fakeServices('local'))
    await switcher.connect({ link: 'http://studio.local:4817/?token=abc' })
    expect(switcher.getSnapshot().current.origin).toBe('remote')
    setFailRemote(true)
    await expect(switcher.connect({ link: 'http://other.local:4817/?token=xyz' })).rejects.toThrow('remote unreachable')
    expect(switcher.getSnapshot().current.origin).toBe('remote')
    expect(switcher.getSnapshot().current.url).toBe('http://studio.local:4817')
    expect(switcher.getSnapshot().current.lastError).toBe('remote unreachable')
  })

  it('returns to the local runtime from useLocal', async () => {
    const { switcher } = setup()
    await switcher.start(fakeServices('local'))
    await switcher.connect({ link: 'http://studio.local:4817/?token=abc' })
    await switcher.useLocal()
    expect(switcher.getSnapshot().current.origin).toBe('local')
    expect(switcher.getSnapshot().current.url).toBe(localDescriptor.workspaceUrl)
  })

  it('restores the last remote host on startup when the saved row still exists', async () => {
    disposed.length = 0
    const dir = mkdtempSync(join(tmpdir(), 'hw-last-host-'))
    const lastHostPath = join(dir, 'last-host.json')
    const savedHosts = new SavedHostsStore(memorySavedHostsBackend())
    savedHosts.remember({ url: 'http://studio.local:4817', token: 'tok', identity: studio, now: 10 })
    writeFileSync(lastHostPath, JSON.stringify({ version: 1, savedId: 'studio-id' }))
    const currents: CurrentHost[] = []
    const switcher = new DesktopHostSwitcher({
      local: { descriptor: localDescriptor },
      savedHosts,
      lastHostPath,
      restoreTimeoutMs: 200,
      connectTimeoutMs: 200,
      buildServices: async (descriptor) => fakeServices(`restore:${descriptor.origin}`, {
        host: descriptor.origin === 'remote' ? studio : undefined,
        url: descriptor.workspaceUrl,
      }),
      onServices(_services, current) { currents.push(current) },
    })
    await switcher.start(fakeServices('local-initial'))
    expect(switcher.getSnapshot().current.origin).toBe('remote')
    expect(switcher.getSnapshot().current.identity?.id).toBe('studio-id')
    expect(disposed).toContain('local-initial')
    expect(currents.at(-1)?.origin).toBe('remote')
  })
})
