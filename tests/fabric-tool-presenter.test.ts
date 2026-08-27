import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { coreToolPresentersPlugin, resolveToolPresentation, toolPresenterSlot } from '../src/ui/tool-presenters.ts'
import { fabricSummaryPalette } from '../src/ui/transcript.tsx'
import { applyResolvedTheme, lightColors } from '../src/ui/theme.ts'


describe('fabric_exec presentation', () => {
  it('uses the active palette for Fabric display metadata', () => {
    applyResolvedTheme('light')
    expect(fabricSummaryPalette()).toEqual({
      background: lightColors.card,
      border: lightColors.borderStrong,
      name: lightColors.text,
      description: lightColors.textMuted,
    })
    applyResolvedTheme('dark')
  })

  it('projects declared display metadata and nested persisted audits', async () => {
    const kernel = new WorkbenchKernel()
    kernel.mount(coreToolPresentersPlugin)
    try {
      const presentation = resolveToolPresentation({
        id: 'fabric-1',
        name: 'fabric_exec',
        args: {
          code: "const result = await pi.read('src/main.tsx')\nreturn result",
          display: { name: 'Inspecting startup', description: 'Read the native entry point' },
        },
        output: 'ok: true',
        details: {
          outputFormat: 'yaml',
          audits: [{ ref: 'pi.read', tool: 'read', provider: 'pi', success: true, args: { path: 'src/main.tsx' }, result: 'import React from react', startedAt: 10, endedAt: 25 }],
        },
        status: 'complete',
        isError: false,
      }, kernel.contributions(toolPresenterSlot))

      expect(presentation.title).toBe('Inspecting startup')
      expect(presentation.language).toBe('yaml')
      expect(presentation.fabric).toMatchObject({
        name: 'Inspecting startup',
        description: 'Read the native entry point',
        outputLanguage: 'yaml',
      })
      expect(presentation.fabric?.audits[0]).toMatchObject({ ref: 'pi.read', tool: 'read', provider: 'pi', durationMs: 15 })
    } finally {
      await kernel.dispose()
    }
  })
})
