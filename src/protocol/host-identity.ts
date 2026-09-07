// Who a workspace host is, as every client sees it. Browser-safe: no node imports.

export type HostOs = 'darwin' | 'linux' | 'windows' | 'unknown'
export type HostArch = 'arm64' | 'x64' | 'other'

// The curated shapes a host can present as its icon. Servers detect one from hardware; unknown builds stay 'server'.
export const HOST_MACHINE_KINDS = ['laptop', 'desktop', 'mac-mini', 'mac-studio', 'linux', 'server', 'cloud'] as const
export type HostMachineKind = (typeof HOST_MACHINE_KINDS)[number]

export interface HostIdentity {
  // Stable per machine across restarts; lives beside the host token.
  id: string
  // Human name, e.g. the Sharing name on macOS or the hostname elsewhere.
  name: string
  os: HostOs
  arch: HostArch
  machine: HostMachineKind
  // Heddlework build serving this host.
  version: string
  protocol: number
}

export function isHostMachineKind(value: unknown): value is HostMachineKind {
  return typeof value === 'string' && (HOST_MACHINE_KINDS as readonly string[]).includes(value)
}

export function isHostIdentity(value: unknown): value is HostIdentity {
  if (!value || typeof value !== 'object') return false
  const host = value as Record<string, unknown>
  return typeof host.id === 'string' && host.id.length > 0
    && typeof host.name === 'string'
    && typeof host.os === 'string' && typeof host.arch === 'string'
    && isHostMachineKind(host.machine)
    && typeof host.version === 'string' && typeof host.protocol === 'number'
}

// Tolerant decode for older hosts and foreign builds: unknown machine kinds fall back to 'server'.
export function normalizeHostIdentity(value: unknown): HostIdentity | undefined {
  if (!value || typeof value !== 'object') return undefined
  const host = value as Record<string, unknown>
  if (typeof host.id !== 'string' || !host.id) return undefined
  return {
    id: host.id,
    name: typeof host.name === 'string' && host.name.trim() ? host.name.trim() : 'Unnamed host',
    os: host.os === 'darwin' || host.os === 'linux' || host.os === 'windows' ? host.os : 'unknown',
    arch: host.arch === 'arm64' || host.arch === 'x64' ? host.arch : 'other',
    machine: isHostMachineKind(host.machine) ? host.machine : 'server',
    version: typeof host.version === 'string' ? host.version : '',
    protocol: typeof host.protocol === 'number' ? host.protocol : 0,
  }
}

// Maps a raw model string (Apple hw.model like 'Mac16,8' resolved to a family name, DMI chassis, or a plain hint) to a kind.
export function hostMachineKindFromHints(hints: { os: HostOs; model?: string | undefined; chassis?: string | undefined; hasDisplay?: boolean | undefined; cloud?: boolean | undefined }): HostMachineKind {
  if (hints.cloud) return 'cloud'
  const model = (hints.model ?? '').toLowerCase()
  if (hints.os === 'darwin') {
    if (model.includes('macbook')) return 'laptop'
    if (model.includes('mac mini') || model.includes('macmini')) return 'mac-mini'
    if (model.includes('mac studio') || model.includes('macstudio')) return 'mac-studio'
    if (model.includes('imac') || model.includes('mac pro') || model.includes('macpro')) return 'desktop'
    return hints.hasDisplay === false ? 'mac-mini' : 'laptop'
  }
  const chassis = (hints.chassis ?? '').toLowerCase()
  if (chassis.includes('laptop') || chassis.includes('notebook') || chassis.includes('portable') || chassis.includes('convertible')) return 'laptop'
  if (chassis.includes('desktop') || chassis.includes('tower') || chassis.includes('all in one')) return 'desktop'
  if (chassis.includes('server') || chassis.includes('rack') || chassis.includes('blade')) return 'server'
  if (hints.os === 'windows') return 'desktop'
  if (hints.os === 'linux') return hints.hasDisplay ? 'linux' : 'server'
  return 'server'
}

export function hostMachineLabel(kind: HostMachineKind): string {
  switch (kind) {
    case 'laptop': return 'Laptop'
    case 'desktop': return 'Desktop'
    case 'mac-mini': return 'Mac mini'
    case 'mac-studio': return 'Mac Studio'
    case 'linux': return 'Linux'
    case 'server': return 'Server'
    case 'cloud': return 'Cloud'
  }
}

// Short label for chips: 'Alexander's MacBook Pro' -> 'Alexander's MacBook Pro'; hostnames lose their domain suffix.
export function shortHostName(identity: Pick<HostIdentity, 'name'>): string {
  const name = identity.name.trim()
  if (!name) return 'Unnamed host'
  if (name.includes(' ')) return name
  return name.replace(/\.(local|lan|home|internal|localdomain)$/i, '')
}
