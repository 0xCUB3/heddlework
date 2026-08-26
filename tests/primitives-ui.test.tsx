import React, { useState } from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { ChipSelect, type SelectOption } from '../src/ui/primitives.tsx'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const options: SelectOption[] = Array.from({ length: 24 }, (_, index) => ({
  value: `provider/model-${index}`,
  label: `Model ${index}`,
  detail: `provider/model-${index}`,
}))

function SelectFixture() {
  const [value, setValue] = useState(options.at(-1)!.value)
  return (
    <div style={{ width: 620, height: 560, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40 }}>
      <ChipSelect testId="overflow-model-picker" value={value} options={options} width={300} onChange={setValue} />
    </div>
  )
}

describeNative('bounded select content', () => {
  it('clips long model lists inside a scrollable border', async () => {
    const root = createTestRoot()
    root.render(<SelectFixture />)
    const automation = await connectTest(root.renderer)

    await automation.getByTestId('overflow-model-picker').click()
    await Bun.sleep(20)
    root.renderer.flush()
    const content = (await automation.getByTestId('overflow-model-picker-content').all())[0]!
    expect(content.style?.overflow).toBe('scroll')
    expect(content.bounds?.height).toBeLessThanOrEqual(340)
    expect(await automation.getByTestId('overflow-model-picker-option').count()).toBe(24)

    root.renderer.scrollTo(content.id, 0, -10_000)
    root.renderer.flush()
    expect(root.renderer.getScrollOffset(content.id)?.[1]).toBeLessThan(0)
    expect(root.renderer.getPaintedText()).toContain('Model 23')

    await automation.close()
    root.unmount()
  })
})
