import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { trafficLightInset } from '../src/ui/window-chrome.ts'

describe('sidebar session footer', () => {
  it('renders the session branch or an empty slot, matching t3code', () => {
    const row = readFileSync(new URL('../src/ui/sidebar-session-row.tsx', import.meta.url), 'utf8')
    expect(row).toContain('{session.branch ? <div')
    expect(row).toContain('>{session.branch}</text>')
    expect(row).not.toContain('shortPath')
    expect(row).not.toContain('workspaceDiff')
    const layout = readFileSync(new URL('../packaging/ios/Heddlework/WorkbenchLayout.swift', import.meta.url), 'utf8')
    expect(layout).toContain('guard let branch = session.branch, !branch.isEmpty else { return nil }')
    const view = readFileSync(new URL('../packaging/ios/Heddlework/WorkspaceView.swift', import.meta.url), 'utf8')
    expect(view).toContain('if let branch = SessionCatalog.footerLabel(session: session)')
    expect(view).toContain('Image(systemName: "arrow.triangle.branch")')
  })
})

describe('traffic light inset', () => {
  it('is zero under a browser document even on macOS', () => {
    const had = 'document' in globalThis
    const previous = (globalThis as { document?: unknown }).document
    ;(globalThis as { document?: unknown }).document = {}
    try {
      expect(trafficLightInset(1)).toBe(0)
    } finally {
      if (had) (globalThis as { document?: unknown }).document = previous
      else delete (globalThis as { document?: unknown }).document
    }
  })

  it('reserves space on native macOS windows scaled by titlebar progress', () => {
    const expected = process.platform === 'darwin' ? 48 : 0
    expect(trafficLightInset(0.5)).toBe(expected)
    expect(trafficLightInset(1, 90)).toBe(process.platform === 'darwin' ? 90 : 0)
  })
})
