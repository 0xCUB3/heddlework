import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { ChangedFilesCard } from '../src/ui/transcript.tsx'

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('changed-files summary', () => {
  it('opens the existing Diff surface', async () => {
    let openCount = 0
    const root = createTestRoot()
    root.render(
      <div style={{ width: 640, padding: 20 }}>
        <ChangedFilesCard
          paths={['src/ui/sidebar.tsx', 'src/ui/composer.tsx']}
          onOpenDiff={() => { openCount += 1 }}
        />
      </div>,
    )
    const automation = await connectTest(root.renderer)

    expect(root.renderer.getPaintedText()).toContain('2 changed files')
    expect(root.renderer.getPaintedText()).toContain('Open diff')
    await automation.getByTestId('changed-files-open-diff').click()
    expect(openCount).toBe(1)

    await automation.close()
    root.unmount()
  })
})
