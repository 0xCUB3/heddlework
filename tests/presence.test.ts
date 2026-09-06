import { describe, expect, it } from 'bun:test'
import { PresenceRegistry, routeAttention, type ClientPresence } from '../src/workbench/presence.ts'

function client(partial: Partial<ClientPresence> & Pick<ClientPresence, 'clientId' | 'visibility'>): ClientPresence {
  return {
    surface: 'web',
    lastSeenAt: 1_000,
    ...partial,
  }
}

describe('attention routing', () => {
  it('stays quiet when any live client is focused on the same session', () => {
    const targets = routeAttention(
      { sessionPath: '/a', createdAt: 1_000 },
      [
        client({ clientId: 'desktop', surface: 'desktop', visibility: 'focused', sessionPath: '/a', lastSeenAt: 1_000 }),
        client({ clientId: 'phone', surface: 'ios', visibility: 'hidden', sessionPath: '/b', lastSeenAt: 1_000 }),
      ],
      1_000,
    )
    expect(targets).toEqual([])
  })

  it('stays quiet when a client has the app in the foreground even on another session', () => {
    const targets = routeAttention(
      { sessionPath: '/a', createdAt: 1_000 },
      [client({ clientId: 'web', visibility: 'focused', sessionPath: '/other', lastSeenAt: 1_000 })],
      1_000,
    )
    expect(targets).toEqual([])
  })

  it('notifies exactly one away client and ignores stale sockets', () => {
    const targets = routeAttention(
      { sessionPath: '/a', createdAt: 50_000 },
      [
        client({ clientId: 'stale', visibility: 'hidden', lastSeenAt: 1_000 }),
        client({ clientId: 'phone', surface: 'ios', visibility: 'hidden', lastSeenAt: 49_000 }),
        client({ clientId: 'web', visibility: 'hidden', lastSeenAt: 40_000 }),
      ],
      50_000,
    )
    expect(targets).toEqual(['phone'])
  })

  it('upserts presence and drops stale entries from the registry', () => {
    const registry = new PresenceRegistry()
    registry.upsert({ clientId: 'web', surface: 'web', visibility: 'hidden', lastSeenAt: 1 })
    registry.upsert({ clientId: 'web', surface: 'web', visibility: 'focused', sessionPath: '/a', lastSeenAt: 20_000 })
    expect(registry.get('web')?.visibility).toBe('focused')
    expect(registry.list(20_000)).toHaveLength(1)
    expect(registry.list(80_000)).toEqual([])
  })
})
