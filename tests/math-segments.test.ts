import { describe, expect, it } from 'bun:test'
import { containsPotentialMath, segmentMathMarkdown } from '../src/ui/math-segment.ts'

describe('math segmentation', () => {
  it('passes plain markdown through as a single text segment', () => {
    expect(containsPotentialMath('plain text')).toBe(false)
    expect(segmentMathMarkdown('hello **world**')).toEqual([
      { kind: 'text', text: 'hello **world**' },
    ])
  })

  it('segments inline dollar spans with surrounding text preserved', () => {
    expect(segmentMathMarkdown('a $E=mc^2$ b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'math', latex: 'E=mc^2', display: false, standalone: false },
      { kind: 'text', text: ' b' },
    ])
  })

  it('segments parenthesised inline math', () => {
    expect(segmentMathMarkdown('a \\(a_1 + a_2\\) b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'math', latex: 'a_1 + a_2', display: false, standalone: false },
      { kind: 'text', text: ' b' },
    ])
  })

  it('segments bracketed display math', () => {
    expect(segmentMathMarkdown('a \\[x^2\\] b')).toEqual([
      { kind: 'text', text: 'a ' },
      { kind: 'math', latex: 'x^2', display: true, standalone: false },
      { kind: 'text', text: ' b' },
    ])
  })

  it('segments multi-line display math as standalone', () => {
    expect(segmentMathMarkdown('$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$')).toEqual([
      { kind: 'math', latex: '\\int_0^\\infty e^{-x}\\,dx = 1', display: true, standalone: true },
    ])
  })

  it('treats currency amounts as plain text', () => {
    expect(containsPotentialMath('costs $5 and $10 total')).toBe(true)
    expect(segmentMathMarkdown('costs $5 and $10 total')).toEqual([
      { kind: 'text', text: 'costs $5 and $10 total' },
    ])
  })

  it('skips dollar signs inside fenced code blocks', () => {
    const source = ['```math', '\\frac{1}{2} + $x$', '```'].join('\n')
    expect(segmentMathMarkdown(source)).toEqual([{ kind: 'text', text: source }])
  })

  it('skips dollar signs inside inline code spans', () => {
    expect(segmentMathMarkdown('use `$x^2$` here')).toEqual([
      { kind: 'text', text: 'use `$x^2$` here' },
    ])
  })

  it('keeps escaped dollars literal', () => {
    expect(segmentMathMarkdown('\\$5 and \\$10')).toEqual([
      { kind: 'text', text: '\\$5 and \\$10' },
    ])
  })

  it('matches display environments with stacked begin/end', () => {
    expect(segmentMathMarkdown('\\begin{aligned}\nx &= 1\n\\end{aligned}')).toEqual([
      { kind: 'math', latex: '\\begin{aligned}\nx &= 1\n\\end{aligned}', display: true, standalone: true },
    ])
  })

  it('segments inline math inside markdown tables', () => {
    const source = ['| tool | seeds | $s$ |', '| --- | --- | --- |'].join('\n')
    expect(segmentMathMarkdown(source)).toEqual([
      { kind: 'text', text: '| tool | seeds | ' },
      { kind: 'math', latex: 's', display: false, standalone: false },
      { kind: 'text', text: ' |\n| --- | --- | --- |' },
    ])
  })

  it('ignores empty formula pairs', () => {
    expect(segmentMathMarkdown('$$$$')).toEqual([{ kind: 'text', text: '$$$$' }])
  })
})
