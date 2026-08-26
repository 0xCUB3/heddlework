import { describe, expect, it } from 'bun:test'
import { parseWrappedDiff } from '../src/ui/diff-panel.tsx'
import { nativeTheme } from '../src/ui/theme.ts'

describe('working tree diff presentation', () => {
  it('uses a resolvable monospaced family and preserves wrapped line numbers', () => {
    expect(nativeTheme.fontMono).toBe('Menlo')
    const rows = parseWrappedDiff('@@ -4,2 +4,2 @@\n-old value\n+new value\n context')
    expect(rows[1]).toMatchObject({ oldLine: 4, newLine: undefined, marker: '−', text: 'old value', tone: 'delete' })
    expect(rows[2]).toMatchObject({ oldLine: undefined, newLine: 4, marker: '+', text: 'new value', tone: 'add' })
    expect(rows[3]).toMatchObject({ oldLine: 5, newLine: 5, text: 'context', tone: 'normal' })
  })
})
