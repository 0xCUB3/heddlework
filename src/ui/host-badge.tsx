import React, { useSyncExternalStore } from 'react'
import type { HostMachineKind } from '../protocol/host-identity.ts'
import { shortHostName } from '../protocol/host-identity.ts'
import type { CurrentHost, HostLinkStatus, HostSwitcherSnapshot, HostSwitcherSurface } from '../client/host-switcher.ts'
import { hostLabelFromUrl } from '../client/saved-hosts.ts'
import { Icon, type IconName } from './icons.tsx'
import { colors } from './theme.ts'

export type HostMachineIcon = Extract<IconName, 'laptop' | 'monitor' | 'server' | 'cloud'>

const emptySubscribe = (_listener: () => void): (() => void) => () => undefined
const noHostSnapshot = (): undefined => undefined

export function useHostSwitcherSnapshot(switcher: HostSwitcherSurface | undefined): HostSwitcherSnapshot | undefined {
  return useSyncExternalStore(
    switcher ? switcher.subscribe : emptySubscribe,
    switcher ? switcher.getSnapshot : noHostSnapshot,
  )
}

export function hostMachineIcon(machine: HostMachineKind | undefined): HostMachineIcon {
  switch (machine) {
    case 'laptop': return 'laptop'
    case 'desktop':
    case 'mac-mini':
    case 'mac-studio': return 'monitor'
    case 'cloud': return 'cloud'
    default: return 'server'
  }
}

export function hostDisplayName(current: CurrentHost): string {
  if (current.origin === 'local' && !current.identity) return process.platform === 'darwin' ? 'This Mac' : 'Local'
  if (current.identity) return shortHostName(current.identity)
  return current.url ? hostLabelFromUrl(current.url) : 'Host'
}

export function hostStatusColor(status: HostLinkStatus): string {
  if (status === 'open') return colors.success
  if (status === 'connecting') return colors.warning
  return colors.error
}

export function HostBadge({
  snapshot,
  compact = false,
  onClick,
}: {
  snapshot: HostSwitcherSnapshot
  compact?: boolean
  onClick(): void
}) {
  const remote = snapshot.current.origin === 'remote'
  const name = hostDisplayName(snapshot.current)
  return (
    <div
      testId="host-badge"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'enter' || event.key === 'space') onClick()
      }}
      style={{
        height: 26,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'row',
        alignItems: 'center',
        gap: compact ? 5 : 6,
        paddingLeft: compact ? 6 : 7,
        paddingRight: compact ? 6 : 8,
        borderRadius: 8,
        borderWidth: remote ? 1 : 0,
        borderColor: colors.borderStrong,
        backgroundColor: remote ? colors.raised : colors.transparent,
        cursor: 'pointer',
        userSelect: 'none',
        hover: { backgroundColor: remote ? colors.hover : colors.sidebarHover },
      }}
    >
      <Icon name={hostMachineIcon(snapshot.current.identity?.machine)} size={13} color={colors.textMuted} />
      {!compact && (
        <text testId="host-badge-name" style={{ color: colors.text, fontSize: 11, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis', maxWidth: 160 }}>{name}</text>
      )}
      <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: hostStatusColor(snapshot.current.status), flexShrink: 0 }} />
    </div>
  )
}
