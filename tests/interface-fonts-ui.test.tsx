import React from 'react'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { WorkbenchApp } from '../src/ui/app.tsx'
import { Transcript } from '../src/ui/transcript.tsx'
import { DEFAULT_INTERFACE_FONTS, applyResolvedTheme, nativeTheme } from '../src/ui/theme.ts'
import { ThemeManager } from '../src/ui/theme-manager.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { createInitialState } from '../src/workbench/state.ts'
import { createTestUiRegistry, testControllerDependencies } from './helpers/workbench.ts'

const describeNative = hasNativeTestRenderer ? describe : describe.skip
const family = 'ComicShannsMono Nerd Font Mono'

describeNative('desktop interface fonts', () => {
  it('applies, persists, and resets both controls without changing terminal preferences', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'heddlework-font-ui-'))
    const preferencePath = join(workspace, 'preferences.json')
    const manager = new ThemeManager({ preferencePath, resolveSystemTheme: () => 'dark' })
    const controller = new WorkbenchController(new DemoTransport(), workspace, testControllerDependencies())
    const terminals = new TerminalSessionService({ cwd: workspace, backend: new MemoryTerminalBackend() })
    const terminalAppearance = terminals.getSnapshot().appearance
    const root = createTestRoot({ width: 1_280, height: 1_200 })
    root.render(<WorkbenchApp controller={controller} presenters={new Map()} ui={createTestUiRegistry(controller)} themeManager={manager} terminals={terminals} />)
    const automation = await connectTest(root.renderer)
    try {
      await controller.start()
      await controller.submit('/settings')
      await Bun.sleep(30)
      root.renderer.flush()
      const settingsId = root.renderer.findByTestId('settings-view')!.id
      await automation.getByTestId('interface-font-family').fill(family)
      await automation.getByTestId('interface-font-family-apply').click()
      root.renderer.flush()
      expect(root.renderer.findByTestId('workbench-root')!.style.fontFamily).toBe(family)
      expect(nativeTheme.fontSans).toBe(family)
      expect(nativeTheme.fontMono).toBe(DEFAULT_INTERFACE_FONTS.fontMono)
      await automation.getByTestId('interface-code-font-family').fill(family)
      await automation.getByTestId('interface-code-font-family-apply').click()
      root.renderer.flush()
      expect(nativeTheme.fontMono).toBe(family)
      expect(root.renderer.findByTestId('settings-view')!.id).toBe(settingsId)
      expect(JSON.parse(readFileSync(preferencePath, 'utf8')).interfaceFonts).toEqual({ fontSans: family, fontMono: family })
      await automation.getByTestId('theme-mode-light').click()
      expect(manager.getSnapshot().fonts).toEqual({ fontSans: family, fontMono: family })
      await automation.getByTestId('interface-fonts-reset').click()
      root.renderer.flush()
      expect(manager.getSnapshot().fonts).toEqual(DEFAULT_INTERFACE_FONTS)
      expect(manager.getSnapshot().mode).toBe('light')
      expect(root.renderer.findByTestId('workbench-root')!.style.fontFamily).toBe(DEFAULT_INTERFACE_FONTS.fontSans)
      expect(terminals.getSnapshot().appearance).toEqual(terminalAppearance)
    } finally {
      await automation.close()
      root.unmount()
      manager.dispose()
      await controller.dispose()
      await terminals.dispose()
      rmSync(workspace, { recursive: true, force: true })
      applyResolvedTheme('dark')
    }
  }, 15_000)

  it('repaints already mounted memoized transcript markdown without remounting its list', async () => {
    const manager = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
    const state = {
      ...createInitialState('/tmp/font-transcript'),
      messages: [{ role: 'assistant' as const, workbenchEntryId: 'answer', content: 'Font preview with `code`.', timestamp: 1 }],
    }
    const root = createTestRoot({ width: 900, height: 640 })
    root.render(<div style={{ width: 900, height: 640, display: 'flex', flexDirection: 'column' }}><Transcript state={state} presenters={new Map()} onOpenDiff={() => {}} onRevert={() => {}} /></div>)
    try {
      root.renderer.flush()
      const listId = root.renderer.findByTestId('transcript-list')!.id
      expect(root.renderer.findByType('markdown').length).toBeGreaterThan(0)
      manager.setFonts({ fontSans: family, fontMono: family })
      await Bun.sleep(30)
      root.renderer.flush()
      const markdown = root.renderer.findByType('markdown')[0]!
      expect(markdown.customProps?.theme).toMatchObject({ fontSans: family, fontMono: family })
      expect(root.renderer.findByTestId('transcript-list')!.id).toBe(listId)
    } finally {
      root.unmount()
      manager.dispose()
      applyResolvedTheme('dark')
    }
  })
})
