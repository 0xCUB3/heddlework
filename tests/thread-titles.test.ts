import { describe, expect, it } from 'bun:test'
import {
  buildTitleContext,
  canApplyAutoTitle,
  initialTitlePrompt,
  normalizeThreadTitleSettings,
  pickTitleModel,
  regenerateTitlePrompt,
  sanitizeThreadTitle,
} from '../src/workbench/thread-titles.ts'

describe('sanitizeThreadTitle', () => {
  it('unwraps json, strips terminal noise and quotes, and collapses whitespace', () => {
    expect(sanitizeThreadTitle('\u001b]777;notify;Pi;Ready for input\u0007{"title":"  Fix   Lazy Feed Test."}')).toBe('Fix Lazy Feed Test')
    expect(sanitizeThreadTitle('"Host switching UI"\nignored second line')).toBe('Host switching UI')
    expect(sanitizeThreadTitle('Title: Cache invalidation bug')).toBe('Cache invalidation bug')
    expect(sanitizeThreadTitle('   ')).toBe('')
  })
  it('caps at a word boundary', () => {
    const long = 'word '.repeat(30)
    const title = sanitizeThreadTitle(long)
    expect(title.length).toBeLessThanOrEqual(60)
    expect(title.endsWith('word')).toBe(true)
  })
})

describe('canApplyAutoTitle', () => {
  it('never overwrites a manual rename and titles unnamed sessions', () => {
    expect(canApplyAutoTitle({ titleSource: 'manual', sessionName: 'Mine' })).toBe(false)
    expect(canApplyAutoTitle({ titleSource: 'auto', sessionName: 'Old auto' })).toBe(true)
    expect(canApplyAutoTitle({ sessionName: 'Named by pi' })).toBe(false)
    expect(canApplyAutoTitle({})).toBe(true)
  })
})

describe('buildTitleContext', () => {
  it('pins the first user message and keeps the newest tail within budget', () => {
    const messages = [
      { role: 'user', content: 'Fix the login redirect loop' },
      { role: 'assistant', content: [{ type: 'text', text: 'Looking at auth middleware' }] },
      { role: 'toolResult', content: 'noise' },
      { role: 'user', content: 'x'.repeat(3000) },
      { role: 'assistant', content: 'Found it in session.ts' },
    ]
    const context = buildTitleContext(messages, 2_000)
    expect(context.startsWith('USER:\nFix the login redirect loop')).toBe(true)
    expect(context).toContain('[Earlier content truncated]')
    expect(context).toContain('ASSISTANT:\nFound it in session.ts')
    expect(context).not.toContain('noise')
    expect(context).not.toContain('x'.repeat(2600))
  })
  it('skips hidden and custom user messages', () => {
    const context = buildTitleContext([
      { role: 'user', content: 'hidden', display: false },
      { role: 'user', content: 'compaction', customType: 'summary' },
      { role: 'user', content: 'real' },
    ])
    expect(context).toBe('USER:\nreal')
  })
})

describe('prompts and settings', () => {
  it('include house instructions and the previous title', () => {
    expect(initialTitlePrompt('hi', { instructions: 'Use Swedish' })).toContain('Additional instructions:\nUse Swedish')
    expect(regenerateTitlePrompt('hi', 'Old')).toContain('The previous title was "Old"')
  })
  it('normalizes settings with defaults', () => {
    expect(normalizeThreadTitleSettings(undefined)).toEqual({ autoTitles: true })
    expect(normalizeThreadTitleSettings({ autoTitles: false, titleModel: ' xai/grok-3-mini ', instructions: '' })).toEqual({ autoTitles: false, titleModel: 'xai/grok-3-mini' })
  })
  it('picks the configured model, else a cheap sibling on the session provider, else the session model', () => {
    const available = [{ provider: 'anthropic', id: 'claude-opus-4' }, { provider: 'anthropic', id: 'claude-haiku-4-5' }]
    expect(pickTitleModel({ settings: { autoTitles: true, titleModel: 'xai/grok-3-mini' }, sessionModel: null, available })).toBe('xai/grok-3-mini')
    expect(pickTitleModel({ settings: { autoTitles: true }, sessionModel: { provider: 'anthropic', id: 'claude-opus-4' }, available })).toBe('anthropic/claude-haiku-4-5')
    expect(pickTitleModel({ settings: { autoTitles: true }, sessionModel: { provider: 'custom', id: 'big' }, available: [{ provider: 'custom', id: 'big' }] })).toBe('custom/big')
    expect(pickTitleModel({ settings: { autoTitles: true }, sessionModel: null, available })).toBeUndefined()
  })
})
