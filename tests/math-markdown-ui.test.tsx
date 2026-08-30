import React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { buildMathRows, MathMarkdown } from '../src/ui/math-markdown.tsx'
import { loadFormulaRenderer } from '../src/ui/math-engine.ts'
import { segmentMathMarkdown } from '../src/ui/math-segment.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

beforeAll(async () => {
  await loadFormulaRenderer()
})

function box(root: ReturnType<typeof createTestRoot>, element: { id: number }) {
  const bounds = root.renderer.getElementBounds(element.id)
  if (!bounds) return { x: 0, y: 0, w: 0, h: 0 }
  return { x: bounds[0]!, y: bounds[1]!, w: bounds[2]!, h: bounds[3]! }
}

async function renderMath(source: string) {
  const root = createTestRoot({ width: 900, height: 400 })
  root.render(React.createElement(MathMarkdown, {
    source,
    theme: undefined,
    testId: undefined,
    style: undefined,
    onLinkClick: undefined,
  }))
  let svgCount = 0
  for (let attempt = 0; attempt < 120; attempt++) {
    await Bun.sleep(25)
    root.renderer.flush()
    svgCount = root.renderer.findByType('svg').length
    if (svgCount > 0) break
  }
  return { root, svgCount }
}

describe('math rows', () => {
  it('keeps inline dollar math in the same row as surrounding text', () => {
    expect(buildMathRows(segmentMathMarkdown('Energy $E = mc^2$ inline'))).toEqual([
      {
        type: 'inline',
        parts: [
          { kind: 'text', source: 'Energy ' },
          { kind: 'math', latex: 'E = mc^2' },
          { kind: 'text', source: ' inline' },
        ],
      },
    ])
  })

  it('puts display math on its own row between markdown paragraphs', () => {
    expect(buildMathRows(segmentMathMarkdown('Before\n\n$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$\n\nAfter'))).toEqual([
      { type: 'markdown', source: 'Before' },
      { type: 'display', latex: '\\int_0^\\infty e^{-x}\\,dx = 1' },
      { type: 'markdown', source: 'After' },
    ])
  })

  it('keeps headings as markdown even when a later paragraph has inline math', () => {
    expect(buildMathRows(segmentMathMarkdown('## 4. Formulas\n\nEnergy $E = mc^2$ inline'))).toEqual([
      { type: 'markdown', source: '## 4. Formulas' },
      {
        type: 'inline',
        parts: [
          { kind: 'text', source: 'Energy ' },
          { kind: 'math', latex: 'E = mc^2' },
          { kind: 'text', source: ' inline' },
        ],
      },
    ])
  })

  it('reconstructs markdown tables with math in cells', () => {
    expect(buildMathRows(segmentMathMarkdown('| Feature | Formula |\n| --- | --- |\n| seed | $s$ |'))).toEqual([
      {
        type: 'table',
        headers: [[{ kind: 'text', source: 'Feature' }], [{ kind: 'text', source: 'Formula' }]],
        rows: [[[{ kind: 'text', source: 'seed' }], [{ kind: 'math', latex: 's' }]]],
      },
    ])
  })
})

describeNative('math markdown', () => {
  it('renders plain markdown untouched', () => {
    const root = createTestRoot({ width: 900, height: 400 })
    root.render(React.createElement(MathMarkdown, { source: 'plain **bold** text', theme: undefined, testId: undefined, style: undefined, onLinkClick: undefined }))
    root.renderer.flush()
    expect(root.renderer.getPaintedText()).toContain('plain bold text')
    expect(root.renderer.findByType('svg')).toHaveLength(0)
    root.unmount()
  })

  it('renders inline math on the same line as surrounding words', async () => {
    const { root, svgCount } = await renderMath('Energy $E = mc^2$ inline and display:')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('Energy')
    expect(painted).toContain('inline')
    expect(painted).not.toContain('mc^2')
    const energy = root.renderer.findByType('text').find((node) => node.text?.includes('Energy'))
    const formula = root.renderer.findByTestId('math-inline')
    expect(energy).toBeTruthy()
    expect(formula).toBeTruthy()
    const energyBox = box(root, energy!)
    const formulaBox = box(root, formula!)
    expect(Math.abs(formulaBox.y - energyBox.y)).toBeLessThan(20)
    expect(formulaBox.x).toBeGreaterThan(energyBox.x)
    root.unmount()
  })

  it('renders math inside markdown tables instead of raw pipes', async () => {
    const { root, svgCount } = await renderMath('| Feature | Formula |\n| --- | --- |\n| seed | $s$ |')
    expect(svgCount).toBeGreaterThan(0)
    expect(root.renderer.findByTestId('math-table')).toBeTruthy()
    expect(root.renderer.findByTestId('math-inline')).toBeTruthy()
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('Feature')
    expect(painted).toContain('seed')
    expect(painted).not.toContain('$s$')
    root.unmount()
  })

  it('keeps headings out of the inline word-split path', async () => {
    const { root, svgCount } = await renderMath('## 4. Formulas\n\nEnergy $E = mc^2$ inline')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join(' ')
    expect(painted).toContain('4. Formulas')
    expect(painted).not.toContain('##')
    expect(painted).toContain('Energy')
    root.unmount()
  })

  it('renders display math centered with a line of space above and below', async () => {
    const { root, svgCount } = await renderMath('Before\n\n$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$\n\nAfter')
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join('\n')
    expect(painted).toContain('Before')
    expect(painted).toContain('After')
    expect(painted).not.toContain('\\int_0')
    const formula = root.renderer.findByTestId('math-display')
    expect(formula).toBeTruthy()
    const markdowns = root.renderer.findByType('markdown')
    const before = markdowns[0]!
    const after = markdowns[markdowns.length - 1]!
    const formulaBox = box(root, formula!)
    const beforeBox = box(root, before)
    const afterBox = box(root, after)
    expect(Math.abs(formulaBox.x - (900 - formulaBox.w) / 2)).toBeLessThan(8)
    expect(formulaBox.y).toBeGreaterThan(beforeBox.y + beforeBox.h + 14)
    expect(afterBox.y).toBeGreaterThan(formulaBox.y + formulaBox.h + 14)
    root.unmount()
  })
})
