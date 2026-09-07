import React, { useState, useSyncExternalStore } from 'react'
import { useWindowSize } from '@gpuix/react'
import type { HostSwitcherSnapshot, HostSwitcherSurface } from '../client/host-switcher.ts'
import type { SavedHost } from '../client/saved-hosts.ts'
import { hostMachineLabel } from '../protocol/host-identity.ts'
import { DropdownSurface, useDropdownState } from './dropdown.tsx'
import { HostBadge, hostDisplayName, hostMachineIcon, hostStatusColor } from './host-badge.tsx'
import { Icon } from './icons.tsx'
import { Button } from './primitives.tsx'
import { colors, nativeTheme } from './theme.ts'

export function relativeLastSeen(timestamp: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000))
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  return `${Math.floor(days / 7)}w ago`
}

function hostStatusText(status: HostSwitcherSnapshot['current']['status']): string {
  if (status === 'open') return 'Connected'
  if (status === 'connecting') return 'Connecting'
  return 'Disconnected'
}

export function HostSwitcherChip({ switcher, compact = false }: { switcher: HostSwitcherSurface; compact?: boolean }) {
  const snapshot = useSyncExternalStore(switcher.subscribe, switcher.getSnapshot)
  const dropdown = useDropdownState()
  return (
    <div style={{ position: 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', flexShrink: 0 }}>
      <HostBadge snapshot={snapshot} compact={compact} onClick={dropdown.toggle} />
      {dropdown.mounted && <HostPicker switcher={switcher} open={dropdown.open} onClose={() => dropdown.setOpen(false)} />}
    </div>
  )
}

export function HostPicker({ switcher, open, onClose }: { switcher: HostSwitcherSurface; open: boolean; onClose(): void }) {
  const snapshot = useSyncExternalStore(switcher.subscribe, switcher.getSnapshot)
  const windowSize = useWindowSize({ intervalMs: 100 })
  const escape = (event: { key?: string }) => { if (open && event.key === 'escape') onClose() }
  const run = async (action: Promise<void>, closeOnSuccess = true): Promise<void> => {
    try {
      await action
      if (closeOnSuccess) onClose()
    } catch {
      // lastError lands on the snapshot under the add-computer input.
    }
  }
  return (
    <>
      {open && <anchored position={{ x: 0, y: 0 }} deferred priority={7} occlude>
        <div testId="host-picker-dismiss" autoFocus tabIndex={0} style={{ width: windowSize.width, height: windowSize.height, backgroundColor: colors.transparent }} onClick={onClose} onKeyDown={escape} />
      </anchored>}
      <anchored side="bottom" align="start" gap={5} fit="snap" snapMargin={8} deferred priority={8} occlude>
        <div testId="host-picker-positioner" style={{ display: 'flex', backgroundColor: colors.background, pointerEvents: open ? 'auto' : 'none' }}>
          <DropdownSurface testId="host-picker" open={open} tabIndex={0} onKeyDown={escape} style={{ width: 320, padding: 6, borderRadius: 10, opacity: snapshot.busy ? 0.55 : 1 }}>
            <HostListBody switcher={switcher} snapshot={snapshot} variant="menu" disabled={snapshot.busy} onConnect={(target) => void run(switcher.connect(target))} onLocal={() => void run(switcher.useLocal())} />
          </DropdownSurface>
        </div>
      </anchored>
    </>
  )
}

export function HostListBody({
  switcher,
  snapshot,
  variant,
  disabled,
  onConnect,
  onLocal,
}: {
  switcher: HostSwitcherSurface
  snapshot: HostSwitcherSnapshot
  variant: 'menu' | 'settings'
  disabled: boolean
  onConnect(target: { link: string } | { savedId: string }): void
  onLocal(): void
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: variant === 'menu' ? 2 : 0 }}>
      <HostCurrentRow snapshot={snapshot} variant={variant} />
      {snapshot.canUseLocal && snapshot.current.origin === 'remote' ? (
        <HostLocalRow disabled={disabled} variant={variant} onClick={onLocal} />
      ) : null}
      {snapshot.saved.length > 0 ? <HostDivider /> : null}
      {snapshot.saved.map((host) => (
        <SavedHostRow
          key={host.id}
          host={host}
          variant={variant}
          disabled={disabled}
          allowRename={variant === 'settings'}
          showConnect={variant === 'settings'}
          onConnect={() => onConnect({ savedId: host.id })}
          onForget={() => switcher.forget(host.id)}
          {...(variant === 'settings' ? { onRename: (name: string) => switcher.rename(host.id, name) } : {})}
        />
      ))}
      <HostDivider />
      <HostAddComputer lastError={snapshot.current.lastError} disabled={disabled} onConnect={(link) => onConnect({ link })} />
    </div>
  )
}

export function HostCurrentRow({ snapshot, variant }: { snapshot: HostSwitcherSnapshot; variant: 'menu' | 'settings' }) {
  const current = snapshot.current
  const name = hostDisplayName(current)
  const machine = current.identity ? hostMachineLabel(current.identity.machine) : current.origin === 'local' ? 'This computer' : 'Remote'
  return (
    <div testId="host-picker-current" style={rowStyle(variant)}>
      <Icon name={hostMachineIcon(current.identity?.machine)} size={14} color={colors.textMuted} />
      <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <text style={{ color: colors.text, fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{name}</text>
        <text style={{ color: colors.textFaint, fontSize: 10, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{machine}{current.url ? ' · ' + current.url : ''}</text>
        {current.lastError ? <text style={{ color: colors.error, fontSize: 10, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{current.lastError}</text> : null}
      </div>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        <text style={{ color: hostStatusColor(current.status), fontSize: 10, fontWeight: 550 }}>{hostStatusText(current.status)}</text>
        <div style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: hostStatusColor(current.status) }} />
      </div>
    </div>
  )
}

export function HostLocalRow({ disabled, variant, onClick }: { disabled: boolean; variant: 'menu' | 'settings'; onClick(): void }) {
  return (
    <div
      testId="host-picker-local"
      tabIndex={disabled ? -1 : 0}
      onClick={() => { if (!disabled) onClick() }}
      onKeyDown={(event) => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onClick() }}
      style={{ ...rowStyle(variant), opacity: disabled ? 0.45 : 1, cursor: disabled ? 'default' : 'pointer', ...(disabled ? {} : { hover: { backgroundColor: colors.hover } }) }}
    >
      <Icon name="laptop" size={14} color={colors.textMuted} />
      <text style={{ color: colors.text, fontSize: 12, fontWeight: 550 }}>This computer</text>
    </div>
  )
}

export function SavedHostRow({
  host,
  variant,
  disabled,
  allowRename = false,
  showConnect = false,
  onConnect,
  onForget,
  onRename,
}: {
  host: SavedHost
  variant: 'menu' | 'settings'
  disabled: boolean
  allowRename?: boolean
  showConnect?: boolean
  onConnect(): void
  onForget(): void
  onRename?(name: string): void
}) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(host.name)
  const commitRename = () => {
    onRename?.(draft)
    if (draft.trim()) setRenaming(false)
  }
  return (
    <div style={{ ...rowStyle(variant), opacity: disabled ? 0.45 : 1 }}>
      <div
        testId={`host-picker-saved-${host.id}`}
        tabIndex={disabled || renaming ? -1 : 0}
        onClick={() => {
          if (disabled) return
          if (allowRename) {
            setDraft(host.name)
            setRenaming(true)
            return
          }
          onConnect()
        }}
        onKeyDown={(event) => {
          if (disabled || renaming) return
          if (event.key === 'enter' || event.key === 'space') {
            if (allowRename) {
              setDraft(host.name)
              setRenaming(true)
            } else onConnect()
          }
        }}
        style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, cursor: disabled ? 'default' : 'pointer' }}
      >
        <Icon name={hostMachineIcon(host.machine)} size={14} color={colors.textMuted} />
        <div style={{ minWidth: 0, flexGrow: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
          {renaming ? (
            <input
              testId={`host-rename-${host.id}`}
              value={draft}
              autoFocus
              theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }}
              style={{ width: '100%', height: 16, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 12, fontWeight: 550 }}
              onChange={(event) => setDraft(String(event.value ?? ''))}
              onKeyDown={(event) => {
                if (event.key === 'enter') commitRename()
                if (event.key === 'escape') setRenaming(false)
              }}
            />
          ) : (
            <text style={{ color: colors.text, fontSize: 12, fontWeight: 550, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{host.name}</text>
          )}
          <text style={{ color: colors.textFaint, fontSize: 9 }}>{relativeLastSeen(host.lastSeenAt)}</text>
        </div>
      </div>
      {showConnect ? <Button testId={`host-connect-${host.id}`} label="Connect" compact disabled={disabled} onClick={onConnect} /> : null}
      <div
        testId={`host-forget-${host.id}`}
        tabIndex={disabled ? -1 : 0}
        onClick={() => { if (!disabled) onForget() }}
        onKeyDown={(event) => { if (!disabled && (event.key === 'enter' || event.key === 'space')) onForget() }}
        style={{ width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, cursor: disabled ? 'default' : 'pointer', ...(disabled ? {} : { hover: { backgroundColor: colors.hover } }) }}
      >
        <Icon name="x" size={11} color={colors.textFaint} />
      </div>
    </div>
  )
}

export function HostAddComputer({ lastError, disabled, onConnect }: { lastError?: string | undefined; disabled: boolean; onConnect(link: string): void }) {
  const [link, setLink] = useState('')
  const submit = () => {
    const trimmed = link.trim()
    if (!trimmed || disabled) return
    onConnect(trimmed)
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingTop: 6, paddingBottom: 4, paddingLeft: 8, paddingRight: 8 }}>
      <text style={{ color: colors.textMuted, fontSize: 11, fontWeight: 550 }}>Add computer…</text>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <div style={{ minWidth: 0, flexGrow: 1, height: 30, display: 'flex', alignItems: 'center', paddingLeft: 8, paddingRight: 8, borderRadius: 7, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.input, opacity: disabled ? 0.45 : 1 }}>
          <input
            testId="host-picker-link-input"
            value={link}
            placeholder="Paste a connect link from Settings › Remote access"
            theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }}
            style={{ width: 0, minWidth: 0, height: 26, flexGrow: 1, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 11, fontFamily: nativeTheme.fontMono }}
            onChange={(event) => setLink(String(event.value ?? ''))}
            onKeyDown={(event) => { if (event.key === 'enter') submit() }}
          />
        </div>
        <Button testId="host-picker-connect" label="Connect" compact disabled={disabled || !link.trim()} onClick={submit} />
      </div>
      {lastError ? <text testId="host-picker-error" style={{ color: colors.error, fontSize: 10, lineHeight: 14 }}>{lastError}</text> : null}
    </div>
  )
}

function HostDivider() {
  return <div style={{ height: 1, backgroundColor: colors.border, marginTop: 4, marginBottom: 4 }} />
}

function rowStyle(variant: 'menu' | 'settings'): Record<string, unknown> {
  if (variant === 'settings') {
    return { minHeight: 46, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, paddingBottom: 8, paddingLeft: 13, paddingRight: 10, borderWidth: 1, borderColor: colors.border }
  }
  return { minHeight: 36, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 6, paddingBottom: 6, paddingLeft: 8, paddingRight: 6, borderRadius: 7 }
}
