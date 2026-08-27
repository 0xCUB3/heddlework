import { describe, expect, it } from 'bun:test'
import { diffSections, parseWrappedDiff } from '../src/ui/diff-panel.tsx'
import { nativeTheme } from '../src/ui/theme.ts'

describe('working tree diff presentation', () => {
  it('uses a resolvable monospaced family and preserves wrapped line numbers', () => {
    expect(nativeTheme.fontMono).toBe('Menlo')
    const rows = parseWrappedDiff('@@ -4,2 +4,2 @@\n-old value\n+new value\n context')
    expect(rows[1]).toMatchObject({ oldLine: 4, newLine: undefined, marker: '−', text: 'old value', tone: 'delete' })
    expect(rows[2]).toMatchObject({ oldLine: undefined, newLine: 4, marker: '+', text: 'new value', tone: 'add' })
    expect(rows[3]).toMatchObject({ oldLine: 5, newLine: 5, text: 'context', tone: 'normal' })
  })

  it('calculates native file boundaries for sticky header handoff', () => {
    const firstPatch = 'diff --git a/a.ts b/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n keep'
    const sections = diffSections([
      { path: 'a.ts', patch: firstPatch, additions: 1, deletions: 1 },
      { path: 'b.ts', patch: 'diff --git a/b.ts b/b.ts\n@@ -0,0 +1 @@\n+added', additions: 1, deletions: 0 },
    ])
    expect(sections[0]?.start).toBe(0)
    expect(sections[0]?.end).toBe(34 + 28 + 3 * 19 + 8)
    expect(sections[1]?.start).toBe(sections[0]?.end)
    expect(sections[1]?.end).toBeGreaterThan(sections[1]?.start ?? 0)
  })
})
