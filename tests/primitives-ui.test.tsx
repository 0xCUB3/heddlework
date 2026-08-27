import React, { useState } from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { ChipSelect, matchSelectOptions, type SelectOption } from '../src/ui/primitives.tsx'

describe('select option matching', () => {
  it('uses Localterm-style fuzzy matching across model names and provider IDs', () => {
    expect(matchSelectOptions(options, 'm 23').map((option) => option.value)).toEqual(['provider/model-23'])
    expect(matchSelectOptions(options, 'provider 4')[0]?.value).toBe('provider/model-4')
    expect(matchSelectOptions(options, '')).toHaveLength(options.length)
  })
})

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const options: SelectOption[] = Array.from({ length: 24 }, (_, index) => ({
  value: `provider/model-${index}`,
  label: `Model ${index}`,
  detail: `provider/model-${index}`,
}))

function SearchableSelectFixture() {
  const [value, setValue] = useState(options[0]!.value)
  return (
    <div style={{ width: 620, height: 560, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40 }}>
      <ChipSelect searchable testId="searchable-model-picker" value={value} options={options} width={320} onChange={setValue} />
    </div>
  )
}

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
    const content = root.renderer.findByTestId('overflow-model-picker-content')!
    expect(content.style.overflow).toBe('scroll')
    expect((await automation.getByTestId('overflow-model-picker-content').bounds()).height).toBeLessThanOrEqual(340)
    expect(await automation.getByTestId('overflow-model-picker-option').count()).toBe(24)

    root.renderer.scrollTo(content.id, 0, -10_000)
    root.renderer.flush()
    expect(root.renderer.getScrollOffset(content.id)?.[1]).toBeLessThan(0)
    expect(root.renderer.getPaintedText()).toContain('Model 23')

    await automation.close()
    root.unmount()
  })

  it('shows every model and filters them from a focused search field', async () => {
    const root = createTestRoot()
    root.render(<SearchableSelectFixture />)
    const automation = await connectTest(root.renderer)

    await automation.getByTestId('searchable-model-picker').click()
    await Bun.sleep(20)
    root.renderer.flush()
    expect(await automation.getByTestId('searchable-model-picker-search').count()).toBe(1)
    expect(await automation.getByTestId('searchable-model-picker-option').count()).toBe(options.length)
    expect(root.renderer.getPaintedText()).toContain(`${options.length} of ${options.length} models`)

    await automation.getByTestId('searchable-model-picker-search').fill('m 23')
    root.renderer.flush()
    expect(await automation.getByTestId('searchable-model-picker-option').count()).toBe(1)
    expect(root.renderer.getPaintedText()).toContain('Model 23')
    expect(root.renderer.getPaintedText()).toContain(`1 of ${options.length} models`)

    await automation.getByTestId('searchable-model-picker-option').click()
    expect(await automation.getByTestId('searchable-model-picker-content').count()).toBe(0)
    await automation.close()
    root.unmount()
  })
})
