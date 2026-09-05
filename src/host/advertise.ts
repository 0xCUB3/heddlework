import { networkInterfaces } from 'node:os'

// Picks the address a phone should use to reach a host bound to 0.0.0.0.
// Order: HEDDLEWORK_HOST_ADVERTISE, then Tailscale, then LAN, then any other IPv4, then loopback.

export type AdvertiseKind = 'custom' | 'tailscale' | 'lan' | 'other' | 'loopback'

export interface AdvertiseCandidate {
  kind: AdvertiseKind
  address: string
  interfaceName?: string
}

export interface InterfaceAddress {
  address: string
  family: string | number
  internal: boolean
}

export type InterfaceTable = Record<string, InterfaceAddress[] | undefined>

export const ADVERTISE_ENV = 'HEDDLEWORK_HOST_ADVERTISE'

// Tailscale hands out 100.64.0.0/10 (CGNAT) addresses to every node.
export function isTailscaleIPv4(address: string): boolean {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127
}

export function isPrivateIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  if (a === 10) return true
  if (a === 192 && b === 168) return true
  if (a === 172 && b! >= 16 && b! <= 31) return true
  return false
}

function isLinkLocalIPv4(address: string): boolean {
  return address.startsWith('169.254.')
}

export function rankAdvertiseCandidates(interfaces: InterfaceTable, override?: string): AdvertiseCandidate[] {
  const tailscale: AdvertiseCandidate[] = []
  const lan: AdvertiseCandidate[] = []
  const other: AdvertiseCandidate[] = []
  for (const [interfaceName, addresses] of Object.entries(interfaces)) {
    for (const entry of addresses ?? []) {
      if (entry.internal) continue
      if (entry.family !== 'IPv4' && entry.family !== 4) continue
      if (isLinkLocalIPv4(entry.address)) continue
      const candidate = { address: entry.address, interfaceName }
      if (isTailscaleIPv4(entry.address)) tailscale.push({ kind: 'tailscale', ...candidate })
      else if (isPrivateIPv4(entry.address)) lan.push({ kind: 'lan', ...candidate })
      else other.push({ kind: 'other', ...candidate })
    }
  }
  const ranked: AdvertiseCandidate[] = []
  const trimmed = override?.trim()
  if (trimmed && trimmed.toLowerCase() !== 'lan' && trimmed.toLowerCase() !== 'auto') {
    ranked.push({ kind: 'custom', address: trimmed })
  }
  const preferLan = trimmed?.toLowerCase() === 'lan'
  ranked.push(...(preferLan ? [...lan, ...tailscale] : [...tailscale, ...lan]), ...other)
  const seen = new Set<string>()
  const unique = ranked.filter((candidate) => (seen.has(candidate.address) ? false : (seen.add(candidate.address), true)))
  if (unique.length === 0) unique.push({ kind: 'loopback', address: '127.0.0.1' })
  return unique
}

export function advertiseCandidates(environment: Record<string, string | undefined> = process.env): AdvertiseCandidate[] {
  return rankAdvertiseCandidates(networkInterfaces() as InterfaceTable, environment[ADVERTISE_ENV])
}
