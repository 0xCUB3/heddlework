import React from 'react'
import { beforeAll, describe, expect, it } from 'bun:test'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { MathMarkdown } from '../src/ui/math-markdown.tsx'
import { loadFormulaRenderer } from '../src/ui/math-engine.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

beforeAll(async () => {
  await loadFormulaRenderer()
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

  it('renders inline math as vector svg instead of raw delimiters', async () => {
    const root = createTestRoot({ width: 900, height: 400 })
    root.render(React.createElement(MathMarkdown, { source: 'Energy $E = mc^2$ inline and display:', theme: undefined, testId: undefined, style: undefined, onLinkClick: undefined }))
    let svgCount = 0
    for (let attempt = 0; attempt < 120; attempt++) {
      await Bun.sleep(25)
      root.renderer.flush()
      svgCount = root.renderer.findByType('svg').length
      if (svgCount > 0) break
    }
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join('\n')
    expect(painted).toContain('Energy')
    expect(painted).toContain('inline and display:')
    expect(painted).not.toContain('mc^2')
    root.unmount()
  })

  it('renders display math as its own centered svg row', async () => {
    const root = createTestRoot({ width: 900, height: 400 })
    root.render(React.createElement(MathMarkdown, { source: 'Before\n\n$$\n\\int_0^\\infty e^{-x}\\,dx = 1\n$$\n\nAfter', theme: undefined, testId: undefined, style: undefined, onLinkClick: undefined }))
    let svgCount = 0
    for (let attempt = 0; attempt < 120; attempt++) {
      await Bun.sleep(25)
      root.renderer.flush()
      svgCount = root.renderer.findByType('svg').length
      if (svgCount > 0) break
    }
    expect(svgCount).toBeGreaterThan(0)
    const painted = root.renderer.getPaintedText().join('\n')
    expect(painted).toContain('Before')
    expect(painted).toContain('After')
    expect(painted).not.toContain('\\int_0')
    root.unmount()
  })
})
