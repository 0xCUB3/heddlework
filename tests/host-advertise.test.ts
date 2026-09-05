import { describe, expect, test } from 'bun:test'
import { isPrivateIPv4, isTailscaleIPv4, rankAdvertiseCandidates, type InterfaceTable } from '../src/host/advertise.ts'

const v4 = (address: string, internal = false) => ({ address, family: 'IPv4', internal })

const table: InterfaceTable = {
  lo0: [v4('127.0.0.1', true)],
  en0: [v4('192.168.1.20'), { address: 'fe80::1', family: 'IPv6', internal: false }],
  utun4: [v4('100.101.102.103')],
  bridge0: [v4('169.254.10.1')],
}

describe('advertise address ranking', () => {
  test('classifies Tailscale and private ranges', () => {
    expect(isTailscaleIPv4('100.64.0.1')).toBe(true)
    expect(isTailscaleIPv4('100.127.255.254')).toBe(true)
    expect(isTailscaleIPv4('100.128.0.1')).toBe(false)
    expect(isPrivateIPv4('10.0.0.5')).toBe(true)
    expect(isPrivateIPv4('172.20.1.1')).toBe(true)
    expect(isPrivateIPv4('8.8.8.8')).toBe(false)
  })

  test('prefers Tailscale, then LAN, and drops loopback and link-local', () => {
    const ranked = rankAdvertiseCandidates(table)
    expect(ranked.map((c) => [c.kind, c.address])).toEqual([
      ['tailscale', '100.101.102.103'],
      ['lan', '192.168.1.20'],
    ])
    expect(ranked[0]?.interfaceName).toBe('utun4')
  })

  test('HEDDLEWORK_HOST_ADVERTISE=lan flips the order without losing Tailscale', () => {
    expect(rankAdvertiseCandidates(table, 'lan').map((c) => c.kind)).toEqual(['lan', 'tailscale'])
  })

  test('an explicit address or MagicDNS name goes first and the rest stay as fallbacks', () => {
    const ranked = rankAdvertiseCandidates(table, 'mac.tailnet.ts.net')
    expect(ranked[0]).toEqual({ kind: 'custom', address: 'mac.tailnet.ts.net' })
    expect(ranked.length).toBe(3)
    expect(rankAdvertiseCandidates(table, '192.168.1.20').map((c) => c.address)).toEqual(['192.168.1.20', '100.101.102.103'])
  })

  test('falls back to loopback when nothing is reachable', () => {
    expect(rankAdvertiseCandidates({ lo0: [v4('127.0.0.1', true)] })).toEqual([{ kind: 'loopback', address: '127.0.0.1' }])
    expect(rankAdvertiseCandidates({}, '  ')).toEqual([{ kind: 'loopback', address: '127.0.0.1' }])
  })
})
