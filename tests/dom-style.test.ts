import { describe, expect, it } from 'bun:test'
import { toCss } from '../src/dom/style.ts'

describe('dom style paint order', () => {
  it('keeps static siblings above an absolute backdrop by defaulting to relative positioning', () => {
    // GPUI paints children in source order, so a card's absolute hover surface (first child) sits under the text
    // that follows it. CSS paints positioned elements above static ones; relative restores source order.
    expect(toCss({ display: 'flex' }).position).toBe('relative')
    expect(toCss({ position: 'absolute', left: 0, top: 0 }).position).toBe('absolute')
    expect(toCss({ position: 'relative' }).position).toBe('relative')
  })
})
