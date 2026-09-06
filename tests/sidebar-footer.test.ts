import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { shortPath } from '../src/ui/sidebar-session-row.tsx'
import { trafficLightInset } from '../src/ui/window-chrome.ts'

describe('sidebar session footer', () => {
  it('has no branch or workspace input on shared and iOS rows', () => {
    const row = readFileSync(new URL('../src/ui/sidebar-session-row.tsx', import.meta.url), 'utf8')
    expect(row).toContain('{shortPath(session.cwd)}')
    expect(row).not.toMatch(/\bbranch\b/)
    const layout = readFileSync(new URL('../packaging/ios/Heddlework/WorkbenchLayout.swift', import.meta.url), 'utf8')
    expect(layout).toContain('static func footerLabel(session: SessionSummary) -> String')
    expect(layout).not.toContain('branchLabel')
    const view = readFileSync(new URL('../packaging/ios/Heddlework/WorkspaceView.swift', import.meta.url), 'utf8')
    expect(view).toContain('SessionCatalog.footerLabel(session: session)')
    expect(view).not.toContain('SessionCatalog.branchLabel')
  })
  it('shortens host home directories by shape so the browser needs no env access', () => {
    expect(shortPath('/Users/skula/projects/heddlework')).toBe('~/projects/heddlework')
    expect(shortPath('/Users/skula')).toBe('~')
    expect(shortPath('/home/ada/src')).toBe('~/src')
    expect(shortPath('C:\\Users\\ada\\src')).toBe('~\\src')
    expect(shortPath('/opt/work')).toBe('/opt/work')
    expect(shortPath('/Users/Shared/x')).toBe('~/x')
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
