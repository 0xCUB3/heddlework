import { describe, expect, test } from 'bun:test'
import { WorkspaceClient } from '../src/web/client.ts'

// A fake WebSocket that refuses one host and accepts the rest, so rotation can be observed without a network.
function installFakeSocket(state: { deadHost: string; hostUrls: string[] }) {
  const attempts: string[] = []
  class FakeSocket {
    static OPEN = 1
    readyState = 0
    #listeners = new Map<string, Array<(event: unknown) => void>>()
    constructor(public url: string) {
      attempts.push(url)
      queueMicrotask(() => {
        if (url.includes(state.deadHost)) { this.#emit('close', {}); return }
        this.readyState = 1
        this.#emit('open', {})
      })
    }
    addEventListener(type: string, fn: (event: unknown) => void) { this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn]) }
    send(raw: string) {
      const message = JSON.parse(raw) as { kind: string }
      if (message.kind === 'hello') {
        queueMicrotask(() => this.#emit('message', { data: JSON.stringify({ kind: 'welcome', protocol: 1, workspacePath: '/w', snapshot: {}, flows: {}, hostUrls: state.hostUrls }) }))
      }
    }
    close() { this.readyState = 3 }
    #emit(type: string, event: unknown) { for (const fn of this.#listeners.get(type) ?? []) fn(event) }
  }
  const original = globalThis.WebSocket
  ;(globalThis as { WebSocket: unknown }).WebSocket = FakeSocket
  return { attempts, restore: () => { (globalThis as { WebSocket: unknown }).WebSocket = original } }
}

const waitFor = async (predicate: () => boolean, ms = 3000) => {
  const deadline = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const tailscale = 'http://100.1.2.3:47311'
const lan = 'http://192.168.1.20:47311'

describe('client rotates to an advertised fallback address', () => {
  test('learns alternates from welcome', async () => {
    const fake = installFakeSocket({ deadHost: 'nowhere', hostUrls: [tailscale, lan] })
    const client = new WorkspaceClient()
    try {
      client.connect(tailscale, 'tok')
      await waitFor(() => client.getSnapshot().status === 'open')
      expect(client.candidates).toEqual([tailscale, lan])
    } finally {
      client.disconnect()
      fake.restore()
    }
  })

  test('switches to the LAN address after the primary fails twice', async () => {
    const fake = installFakeSocket({ deadHost: '100.1.2.3', hostUrls: [tailscale, lan] })
    const client = new WorkspaceClient()
    try {
      client.connect(tailscale, 'tok', [lan])
      await waitFor(() => client.url === lan && client.getSnapshot().status === 'open', 8000)
      expect(fake.attempts.filter((url) => url.includes('100.1.2.3')).length).toBe(2)
      expect(fake.attempts.at(-1)).toContain('192.168.1.20')
    } finally {
      client.disconnect()
      fake.restore()
    }
  }, 15_000)

  test('stays on the only address when nothing else was advertised', async () => {
    const fake = installFakeSocket({ deadHost: '100.1.2.3', hostUrls: [] })
    const client = new WorkspaceClient()
    try {
      client.connect(tailscale, 'tok')
      await new Promise((resolve) => setTimeout(resolve, 1800))
      expect(client.url).toBe(tailscale)
      expect(fake.attempts.every((url) => url.includes('100.1.2.3'))).toBe(true)
    } finally {
      client.disconnect()
      fake.restore()
    }
  })
})
