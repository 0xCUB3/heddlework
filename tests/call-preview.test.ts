import { describe, expect, it } from 'bun:test'
import { HEADLINE_ARG_KEYS, headlineArg } from '../src/ui/call-preview.ts'

describe('headlineArg', () => {
  it('prefers query for captured tools like fovea_focus', () => {
    expect(headlineArg({ query: 'session-switch.test.ts' })).toBe('session-switch.test.ts')
  })

  it('keeps the dashboard key preference task -> path -> query', () => {
    expect(headlineArg({ query: 'q', path: 'p', task: 't' })).toBe('t')
    expect(headlineArg({ query: 'q', path: 'p' })).toBe('p')
    expect(headlineArg({ query: 'q' })).toBe('q')
  })

  it('falls back to the first payload string and skips structural keys', () => {
    expect(headlineArg({ haystack: 'needle', mode: 'fast', limit: 10 })).toBe('needle')
    expect(headlineArg({ mode: 'fast', limit: 10, type: 'x' })).toBeUndefined()
    expect(headlineArg({ count: 3, active: true })).toBeUndefined()
    expect(headlineArg(undefined)).toBeUndefined()
    expect(headlineArg({})).toBeUndefined()
  })

  it('collapses whitespace and truncates', () => {
    expect(headlineArg({ query: 'line1\nline2\ttab' })).toBe('line1 line2 tab')
    const result = headlineArg({ query: 'a'.repeat(200) }, 10)
    expect(result).toBe(`${'a'.repeat(9)}…`)
  })

  it('keeps query in the preferred key list', () => {
    expect(HEADLINE_ARG_KEYS[0]).toBe('task')
    expect(HEADLINE_ARG_KEYS).toContain('query')
  })
})
