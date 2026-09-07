import React, { useEffect, useMemo, useState } from 'react'
import type { PiSessionSummary } from '../pi/session-catalog.ts'
import { sessionProjectName } from '../pi/session-summary.ts'
import { formatShortcut, SHORTCUTS, type ShortcutAction } from './shortcuts.ts'
import { Icon } from './icons.tsx'
import { colors, nativeTheme } from './theme.ts'

export type PaletteAction =
  | 'thread.new'
  | 'sidebar.toggle'
  | 'terminal.toggle'
  | 'diff.toggle'
  | 'settings.open'
  | 'notifications.toggle'
  | 'compact'
  | 'export'
  | 'reconnect'

export type PaletteItem =
  | {
      kind: 'action'
      id: string
      label: string
      shortcut?: string
      action: PaletteAction
    }
  | {
      kind: 'thread'
      id: string
      label: string
      detail: string
      session: PiSessionSummary
    }

const PALETTE_ACTIONS: readonly { action: PaletteAction; label: string; shortcutAction?: ShortcutAction }[] = [
  { action: 'thread.new', label: 'New thread', shortcutAction: 'thread.new' },
  { action: 'sidebar.toggle', label: 'Toggle sidebar', shortcutAction: 'sidebar.toggle' },
  { action: 'terminal.toggle', label: 'Toggle terminal', shortcutAction: 'terminal.toggle' },
  { action: 'diff.toggle', label: 'Toggle changes', shortcutAction: 'diff.toggle' },
  { action: 'settings.open', label: 'Settings', shortcutAction: 'settings.open' },
  { action: 'notifications.toggle', label: 'Notifications', shortcutAction: 'notifications.toggle' },
  { action: 'compact', label: 'Compact context' },
  { action: 'export', label: 'Export transcript' },
  { action: 'reconnect', label: 'Reconnect' },
]

function shortcutLabel(action: ShortcutAction, platform: string): string | undefined {
  const binding = SHORTCUTS.find((item) => item.action === action)
  return binding ? formatShortcut(binding.key, platform) : undefined
}

function matchesQuery(label: string, query: string): boolean {
  return query.length === 0 || label.toLowerCase().includes(query)
}

export function paletteItems(
  query: string,
  sessions: readonly PiSessionSummary[],
  platform: string = process.platform,
): PaletteItem[] {
  const needle = query.trim().toLowerCase()
  const actions: PaletteItem[] = []
  for (const item of PALETTE_ACTIONS) {
    if (!matchesQuery(item.label, needle)) continue
    const shortcut = item.shortcutAction ? shortcutLabel(item.shortcutAction, platform) : undefined
    actions.push({
      kind: 'action',
      id: item.action,
      label: item.label,
      action: item.action,
      ...(shortcut ? { shortcut } : {}),
    })
  }
  const threads: PaletteItem[] = []
  // Callers pass sessions already in workbench order (pinned first, then recency).
  const ordered = needle ? sessions : sessions.slice(0, 8)
  for (const session of ordered) {
    const project = sessionProjectName(session)
    const label = session.title
    if (!matchesQuery(`${label} ${project}`, needle)) continue
    threads.push({
      kind: 'thread',
      id: session.path,
      label,
      detail: project,
      session,
    })
  }
  return [...actions, ...threads].slice(0, 12)
}

export function CommandPalette({
  sessions,
  onClose,
  onAction,
  onSwitchSession,
  platform = process.platform,
}: {
  sessions: readonly PiSessionSummary[]
  onClose(): void
  onAction(action: PaletteAction): void
  onSwitchSession(session: PiSessionSummary): void
  platform?: string
}) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const items = useMemo(() => paletteItems(query, sessions, platform), [platform, query, sessions])
  useEffect(() => { setActiveIndex(0) }, [query])
  useEffect(() => {
    setActiveIndex((index) => items.length === 0 ? 0 : Math.min(index, items.length - 1))
  }, [items.length])

  const run = (item: PaletteItem | undefined) => {
    if (!item) return
    onClose()
    if (item.kind === 'thread') onSwitchSession(item.session)
    else onAction(item.action)
  }

  const handleKeyDown = (event: { key?: string }) => {
    const key = event.key?.toLowerCase()
    if (key === 'escape') {
      onClose()
      return
    }
    if (items.length === 0) return
    if (key === 'down' || key === 'arrowdown') {
      setActiveIndex((index) => (index + 1) % items.length)
      return
    }
    if (key === 'up' || key === 'arrowup') {
      setActiveIndex((index) => (index - 1 + items.length) % items.length)
      return
    }
    if (key === 'enter' || key === 'return') run(items[activeIndex])
  }

  return (
    <div testId="command-palette-layer" style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 72 }}>
      <div testId="command-palette-dismiss" tabIndex={0} style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, backgroundColor: colors.transparent }} onClick={onClose} onKeyDown={(event) => { if (event.key === 'escape') onClose() }} />
      <div testId="command-palette" style={{ position: 'relative', width: 520, maxHeight: 420, display: 'flex', flexDirection: 'column', borderRadius: 10, borderWidth: 1, borderColor: colors.borderStrong, backgroundColor: colors.popover, overflow: 'hidden' }}>
        <div style={{ height: 44, flexShrink: 0, display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8, paddingLeft: 12, paddingRight: 12, borderBottomWidth: 1, borderColor: colors.borderStrong }}>
          <Icon name="search" size={14} color={colors.textFaint} />
          <input
            testId="command-palette-input"
            value={query}
            placeholder="Run a command or jump to a thread…"
            autoFocus
            theme={{ caret: colors.text, text: colors.text, textMuted: colors.textFaint, bg: colors.transparent }}
            style={{ minWidth: 0, flexGrow: 1, height: 32, borderWidth: 0, backgroundColor: colors.transparent, color: colors.text, fontSize: 13 }}
            onChange={(event) => setQuery(String(event.value ?? ''))}
            onKeyDown={handleKeyDown}
            onSubmit={() => run(items[activeIndex])}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', padding: 6, overflow: 'scroll' }}>
          {items.map((item, index) => {
            const active = index === activeIndex
            return (
              <div
                key={item.id}
                testId={`command-palette-item-${index}`}
                tabIndex={0}
                style={{
                  minHeight: 34,
                  flexShrink: 0,
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                  paddingLeft: 10,
                  paddingRight: 10,
                  borderRadius: 7,
                  backgroundColor: active ? colors.raised : colors.transparent,
                  cursor: 'pointer',
                  hover: { backgroundColor: active ? colors.raised : colors.hover },
                }}
                onClick={() => run(item)}
                onKeyDown={(event) => { if (event.key === 'enter' || event.key === 'space') run(item) }}
              >
                <text style={{ minWidth: 0, flexGrow: 1, color: active ? colors.text : colors.textMuted, fontSize: 12, fontWeight: active ? 650 : 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis' }}>{item.label}</text>
                {item.kind === 'thread' ? <text style={{ color: colors.textFaint, fontSize: 10, whiteSpace: 'nowrap' }}>{item.detail}</text> : null}
                {item.kind === 'action' && item.shortcut ? <text style={{ color: colors.textFaint, fontSize: 10, fontFamily: nativeTheme.fontMono }}>{item.shortcut}</text> : null}
              </div>
            )
          })}
          {items.length === 0 ? (
            <div testId="command-palette-empty" style={{ height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <text style={{ color: colors.textFaint, fontSize: 11 }}>No matching commands</text>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
