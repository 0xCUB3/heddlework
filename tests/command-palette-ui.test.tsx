import React, { useState } from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import type { PiSessionSummary } from '../src/pi/session-catalog.ts'
import { CommandPalette, paletteItems } from '../src/ui/command-palette.tsx'
import { adjacentSession, orderedActiveSessions } from '../src/ui/session-order.ts'
import { colors } from '../src/ui/theme.ts'

function session(id: string, title: string, modifiedAt: number, project = 'heddlework'): PiSessionSummary {
  return {
    id,
    path: `/sessions/${id}.jsonl`,
    cwd: `/tmp/${project}`,
    title,
    firstMessage: title,
    messageCount: 2,
    createdAt: 1,
    modifiedAt,
  }
}

describe('paletteItems', () => {
  it('shows actions then recent threads, filtered by substring, capped at 12', () => {
    const sessions = [
      session('a', 'Alpha', 30),
      session('b', 'Terminal notes', 20, 'infra'),
      session('empty', 'Draft', 40),
      ...Array.from({ length: 10 }, (_, index) => session(`old-${index}`, `Old ${index}`, 10 - index)),
    ]
    sessions[2] = { ...sessions[2]!, messageCount: 0 }

    const ordered = orderedActiveSessions(sessions)
    const empty = paletteItems('', ordered, 'darwin')
    expect(empty.map((item) => item.label)).toEqual([
      'New thread',
      'Rename thread…',
      'Regenerate thread title',
      'Toggle sidebar',
      'Toggle terminal',
      'Toggle changes',
      'Settings',
      'Notifications',
      'Compact context',
      'Export transcript',
      'Reconnect',
      'Alpha',
    ])
    expect(empty[0]).toMatchObject({ kind: 'action', shortcut: '⌘N' })
    expect(empty.filter((item) => item.kind === 'thread')).toHaveLength(1)

    const filtered = paletteItems('term', ordered, 'linux')
    expect(filtered.map((item) => item.label)).toEqual(['Toggle terminal', 'Terminal notes'])
    expect(filtered[0]).toMatchObject({ kind: 'action', shortcut: 'Ctrl+J' })
    expect(filtered[1]).toMatchObject({ kind: 'thread', detail: 'infra' })
  })
})

describe('session order', () => {
  it('keeps message-bearing sessions newest first and wraps adjacency', () => {
    const sessions = [
      session('old', 'Old', 1),
      { ...session('draft', 'Draft', 99), messageCount: 0 },
      session('new', 'New', 5),
    ]
    const ordered = orderedActiveSessions(sessions)
    expect(ordered.map((item) => item.id)).toEqual(['new', 'old'])
    expect(adjacentSession(ordered, '/sessions/new.jsonl', 1)?.id).toBe('old')
    expect(adjacentSession(ordered, '/sessions/old.jsonl', 1)?.id).toBe('new')
    expect(adjacentSession(ordered, '/sessions/new.jsonl', -1)?.id).toBe('old')
    expect(adjacentSession(ordered, '/missing.jsonl', 1)?.id).toBe('new')
  })
})

function PaletteFixture({ sessions = [] }: { sessions?: PiSessionSummary[] }) {
  const [ran, setRan] = useState('')
  return (
    <div testId="palette-fixture" style={{ position: 'relative', width: 800, height: 600 }}>
      <text testId="palette-ran">{ran}</text>
      <CommandPalette
        sessions={sessions}
        platform="darwin"
        onClose={() => undefined}
        onAction={(action) => setRan(action)}
        onSwitchSession={(item) => setRan(item.id)}
      />
    </div>
  )
}

const native = hasNativeTestRenderer ? describe : describe.skip
native('command palette', () => {
  it('highlights Toggle terminal for term and runs it on enter', async () => {
    const root = createTestRoot({ width: 800, height: 600 })
    root.render(<PaletteFixture />)
    await Bun.sleep(0)
    root.renderer.flush()
    const app = await connectTest(root.renderer)
    try {
      expect(await app.getByTestId('command-palette').count()).toBe(1)
      await app.getByTestId('command-palette-input').fill('term')
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await app.getByTestId('command-palette-item-0').textContent()).toContain('Toggle terminal')
      expect(root.renderer.findByTestId('command-palette-item-0')?.style.backgroundColor).toBe(colors.raised)
      expect(await app.getByTestId('command-palette-item-1').count()).toBe(0)
      await app.getByTestId('command-palette-input').press('enter')
      await Bun.sleep(0)
      root.renderer.flush()
      expect(await app.getByTestId('palette-ran').textContent()).toBe('terminal.toggle')
    } finally {
      await app.close()
      root.unmount()
    }
  })
})
