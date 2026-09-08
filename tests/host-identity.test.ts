import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hostMachineKindFromHints, isHostIdentity, normalizeHostIdentity, shortHostName } from '../src/protocol/host-identity.ts'
import { loadOrCreateHostIdentity, probeMachine } from '../src/host/identity.ts'

describe('host identity contract', () => {
  it('detects machine kinds from platform hints', () => {
    expect(hostMachineKindFromHints({ os: 'darwin', model: 'MacBook Pro' })).toBe('laptop')
    expect(hostMachineKindFromHints({ os: 'darwin', model: 'Mac mini' })).toBe('mac-mini')
    expect(hostMachineKindFromHints({ os: 'darwin', model: 'Mac Studio' })).toBe('mac-studio')
    expect(hostMachineKindFromHints({ os: 'darwin', model: 'iMac' })).toBe('desktop')
    expect(hostMachineKindFromHints({ os: 'linux', chassis: 'laptop' })).toBe('laptop')
    expect(hostMachineKindFromHints({ os: 'linux', cloud: true })).toBe('cloud')
    expect(hostMachineKindFromHints({ os: 'linux' })).toBe('server')
    expect(hostMachineKindFromHints({ os: 'windows' })).toBe('desktop')
  })

  it('normalizes foreign identities without rejecting unknown machine kinds', () => {
    const decoded = normalizeHostIdentity({ id: 'abc', name: ' Studio ', os: 'darwin', arch: 'arm64', machine: 'toaster', version: '9', protocol: 1 })
    expect(decoded).toEqual({ id: 'abc', name: 'Studio', os: 'darwin', arch: 'arm64', machine: 'server', version: '9', protocol: 1 })
    expect(isHostIdentity(decoded)).toBe(true)
    expect(normalizeHostIdentity({ name: 'no id' })).toBeUndefined()
    expect(isHostIdentity({ id: 'x', name: 'y', os: 'linux', arch: 'x64', machine: 'toaster', version: '', protocol: 1 })).toBe(false)
  })

  it('shortens hostnames but keeps human names', () => {
    expect(shortHostName({ name: 'studio.local' })).toBe('studio')
    expect(shortHostName({ name: "Alexander's MacBook Pro" })).toBe("Alexander's MacBook Pro")
    expect(shortHostName({ name: '  ' })).toBe('Unnamed host')
  })
})

describe('host identity persistence', () => {
  it('persists one machine id across loads and refreshes hardware facts', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hw-identity-')), 'host-identity.json')
    const probe = { name: 'Bench', model: 'Mac mini' }
    const first = loadOrCreateHostIdentity({ path, os: 'darwin', arch: 'arm64', probe, version: 'test' })
    const second = loadOrCreateHostIdentity({ path, os: 'darwin', arch: 'arm64', probe: { name: 'Bench renamed', model: 'Mac Studio' }, version: 'test' })
    expect(second.id).toBe(first.id)
    expect(first.machine).toBe('mac-mini')
    expect(second).toMatchObject({ name: 'Bench renamed', machine: 'mac-studio', os: 'darwin', arch: 'arm64', version: 'test', protocol: 2 })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ id: first.id })
  })

  it('keeps an in-memory identity when persistence is disabled', () => {
    const identity = loadOrCreateHostIdentity({ path: false, probe: { name: 'Memory' } })
    expect(identity.id).toHaveLength(36)
    expect(identity.name).toBe('Memory')
  })

  it('degrades to the hostname when probes fail', () => {
    const probe = probeMachine('darwin', () => '')
    expect(probe.name.length).toBeGreaterThan(0)
    expect(probe.model).toBe('')
  })
})
