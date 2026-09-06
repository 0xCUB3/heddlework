import { describe, expect, test } from 'bun:test'
import { mergeCandidates, workspaceSocketUrl } from '../src/web/client.ts'

describe('client address candidates', () => {
  test('keeps the working address first and appends advertised alternates once', () => {
    const merged = mergeCandidates('http://100.1.2.3:47311/', ['http://100.1.2.3:47311', 'http://192.168.1.20:47311', 'http://192.168.1.20:47311'])
    expect(merged).toEqual(['http://100.1.2.3:47311', 'http://192.168.1.20:47311'])
  })

  test('handles hosts that advertise nothing', () => {
    expect(mergeCandidates('http://127.0.0.1:47311', undefined)).toEqual(['http://127.0.0.1:47311'])
  })

  test('socket url keeps bracketed IPv6 hosts and adds the token', () => {
    expect(workspaceSocketUrl('http://[fd7a::1]:47311', 'abc')).toBe('ws://[fd7a::1]:47311/ws?token=abc')
  })

  test('maps tailnet HTTPS to wss including a non-443 port', () => {
    expect(workspaceSocketUrl('https://mac.tailnet.ts.net:8443', 'tok')).toBe('wss://mac.tailnet.ts.net:8443/ws?token=tok')
    expect(workspaceSocketUrl('https://mac.tailnet.ts.net', 'tok')).toBe('wss://mac.tailnet.ts.net/ws?token=tok')
  })
})
