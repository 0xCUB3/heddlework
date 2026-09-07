export interface ShortcutKeyEvent {
  key?: string
  keyChar?: string
  modifiers?: { alt?: boolean; cmd?: boolean; ctrl?: boolean; shift?: boolean }
}

export type ShortcutAction =
  | 'sidebar.toggle'
  | 'terminal.toggle'
  | 'diff.toggle'
  | 'palette.toggle'
  | 'thread.new'
  | 'thread.previous'
  | 'thread.next'
  | 'thread.jump'
  | 'settings.open'
  | 'notifications.toggle'
  | 'chat.focusComposer'
  | 'agent.abort'

export interface ShortcutBinding {
  action: ShortcutAction
  key: string
  label: string
}

export const SHORTCUTS: readonly ShortcutBinding[] = [
  { action: 'sidebar.toggle', key: 'mod+b', label: 'Toggle sidebar' },
  { action: 'terminal.toggle', key: 'mod+j', label: 'Toggle terminal' },
  { action: 'diff.toggle', key: 'mod+d', label: 'Toggle changes' },
  { action: 'palette.toggle', key: 'mod+k', label: 'Command palette' },
  { action: 'thread.new', key: 'mod+n', label: 'New thread' },
  { action: 'thread.previous', key: 'mod+shift+[', label: 'Previous thread' },
  { action: 'thread.next', key: 'mod+shift+]', label: 'Next thread' },
  ...Array.from({ length: 9 }, (_, index) => ({
    action: 'thread.jump' as const,
    key: `mod+${index + 1}`,
    label: `Jump to thread ${index + 1}`,
  })),
  { action: 'settings.open', key: 'mod+,', label: 'Open settings' },
  { action: 'notifications.toggle', key: 'mod+shift+i', label: 'Toggle notifications' },
]

export type ResolvedShortcut = { action: ShortcutAction; index?: number }

type ParsedChord = {
  shift: boolean
  alt: boolean
  ctrl: boolean
  cmd: boolean
  mod: boolean
  key: string
}

function parseChord(spec: string): ParsedChord {
  const parts = spec.toLowerCase().split('+')
  const key = parts.at(-1) ?? ''
  const mods = new Set(parts.slice(0, -1))
  return {
    shift: mods.has('shift'),
    alt: mods.has('alt'),
    ctrl: mods.has('ctrl'),
    cmd: mods.has('cmd'),
    mod: mods.has('mod'),
    key,
  }
}

function normalizeKey(value: string): string {
  const key = value.toLowerCase()
  if (key === '{' || key === 'bracketleft') return '['
  if (key === '}' || key === 'bracketright') return ']'
  if (key === 'comma') return ','
  return key
}

function eventKeys(event: ShortcutKeyEvent): string[] {
  const keys = [event.key, event.keyChar].filter((value): value is string => Boolean(value)).map(normalizeKey)
  return [...new Set(keys)]
}

function platformModPressed(event: ShortcutKeyEvent, platform: string): boolean {
  return platform === 'darwin' ? Boolean(event.modifiers?.cmd) : Boolean(event.modifiers?.ctrl)
}

function matchesBinding(event: ShortcutKeyEvent, spec: string, platform: string): boolean {
  if (!platformModPressed(event, platform)) return false
  const chord = parseChord(spec)
  const cmd = Boolean(event.modifiers?.cmd)
  const ctrl = Boolean(event.modifiers?.ctrl)
  const shift = Boolean(event.modifiers?.shift)
  const alt = Boolean(event.modifiers?.alt)
  const wantsCmd = chord.cmd || (chord.mod && platform === 'darwin')
  const wantsCtrl = chord.ctrl || (chord.mod && platform !== 'darwin')
  if (cmd !== wantsCmd || ctrl !== wantsCtrl || shift !== chord.shift || alt !== chord.alt) return false
  return eventKeys(event).includes(normalizeKey(chord.key))
}

export function resolveShortcut(event: ShortcutKeyEvent, platform: string = process.platform): ResolvedShortcut | undefined {
  if (!platformModPressed(event, platform)) return undefined
  for (const binding of SHORTCUTS) {
    if (!matchesBinding(event, binding.key, platform)) continue
    if (binding.action === 'thread.jump') {
      const digit = eventKeys(event).find((key) => /^[1-9]$/.test(key)) ?? binding.key.match(/[1-9]$/)?.[0]
      if (!digit) return { action: binding.action }
      return { action: binding.action, index: Number(digit) - 1 }
    }
    return { action: binding.action }
  }
  return undefined
}

function displayKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key
}

export function formatShortcut(key: string, platform: string = process.platform): string {
  const parts = key.split('+')
  const chordKey = displayKey(parts.at(-1) ?? '')
  const mods = parts.slice(0, -1).map((part) => part.toLowerCase())
  if (platform === 'darwin') {
    const glyphs: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', mod: '⌘', cmd: '⌘' }
    return `${mods.map((mod) => glyphs[mod] ?? '').join('')}${chordKey}`
  }
  const names: string[] = []
  if (mods.includes('mod') || mods.includes('ctrl')) names.push('Ctrl')
  if (mods.includes('cmd')) names.push('Cmd')
  if (mods.includes('alt')) names.push('Alt')
  if (mods.includes('shift')) names.push('Shift')
  names.push(chordKey)
  return names.join('+')
}

export type ShortcutHandlerMap = {
  [K in ShortcutAction]?: K extends 'thread.jump' ? (index: number) => void : () => void
}

export function applyShortcutAction(resolved: ResolvedShortcut, handlers: ShortcutHandlerMap): boolean {
  if (resolved.action === 'thread.jump') {
    if (resolved.index === undefined) return false
    const handler = handlers['thread.jump']
    if (!handler) return false
    handler(resolved.index)
    return true
  }
  const handler = handlers[resolved.action]
  if (!handler) return false
  ;(handler as () => void)()
  return true
}

type ShortcutListener = (event: ShortcutKeyEvent) => boolean

const listeners: ShortcutListener[] = []

export const shortcutBus = {
  dispatch(event: ShortcutKeyEvent): boolean {
    for (const listener of listeners.slice()) {
      if (listener(event)) return true
    }
    return false
  },
  subscribe(listener: ShortcutListener): () => void {
    listeners.unshift(listener)
    return () => {
      const index = listeners.indexOf(listener)
      if (index >= 0) listeners.splice(index, 1)
    }
  },
}
