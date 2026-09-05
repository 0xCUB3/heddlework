import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import uiContract from '../src/workbench/ui-contract.json'
import { paletteToCssProperties } from '../src/web/theme.ts'

describe('web workbench layout parity', () => {
  it('uses the canonical workbench surfaces and panels instead of companion tabs', async () => {
    const app = await readFile(resolve(import.meta.dir, '../src/web/app.tsx'), 'utf8')
    for (const surface of uiContract.surfaces) expect(app).toContain(surface.id)
    for (const panel of uiContract.panels) expect(app).toContain(panel.id)
    expect(app).not.toContain('Companion tabs')
    expect(app).not.toContain('web-tabs')
    expect(app).not.toContain('SettingsSidebarNav')
  })

  it('maps canonical theme tokens onto the web CSS variables', () => {
    const css = paletteToCssProperties(uiContract.colors.dark)
    expect(css['--sidebar']).toBe(uiContract.colors.dark.sidebar)
    expect(css['--composer-frame']).toBe(uiContract.colors.dark.composerFrame)
    expect(css['--font-sans']).toContain(uiContract.typography.fontSans)
    expect(css['--md-text-size']).toBe(`${uiContract.typography.textSize}px`)
    expect(css['--md-line-height']).toBe(`${uiContract.typography.lineHeight}px`)
    expect(css['--header-height']).toBe(`${uiContract.layout.headerHeight}px`)
    expect(css['--settings-max-width']).toBe(`${uiContract.layout.settingsMaxWidth}px`)
  })

  it('keeps the workspace sidebar in settings and stacks every settings section', async () => {
    const app = await readFile(resolve(import.meta.dir, '../src/web/app.tsx'), 'utf8')
    const settings = await readFile(resolve(import.meta.dir, '../src/web/settings.tsx'), 'utf8')
    const css = await readFile(resolve(import.meta.dir, '../src/web/styles.css'), 'utf8')
    expect(app).toContain('SidebarChrome')
    expect(app).toContain('web-settings-done')
    expect(settings).toContain('title="Runtime"')
    expect(settings).toContain('title="Interface"')
    expect(settings).toContain('title="Remote access"')
    expect(settings).toContain('title="Updates"')
    expect(settings).toContain('title="Plugins"')
    expect(settings).toContain('title="Terminal"')
    expect(settings).toContain('title="Browser"')
    expect(settings).toContain('title="About"')
    expect(settings).not.toContain('activeSection')
    expect(css).toContain('--settings-max-width: 720px')
    expect(css).toContain('min-height: 46px')
    expect(css).toContain('min-height: 54px')
    expect(css).toContain('font-size: 14px')
    expect(css).toContain('font-size: 11px')
  })

  it('matches native composer, empty chat, overlay, and toolbar geometry', async () => {
    const css = await readFile(resolve(import.meta.dir, '../src/web/styles.css'), 'utf8')
    const app = await readFile(resolve(import.meta.dir, '../src/web/app.tsx'), 'utf8')
    expect(css).toContain('border-radius: 22px')
    expect(css).toContain('line-height: 21px')
    expect(css).toContain('width: 34px')
    expect(css).toContain('left: 22px')
    expect(css).toContain('height: 48px')
    expect(css).toContain('padding-bottom: 32px')
    expect(css).toContain('font-size: 26px')
    expect(css).toContain('gap: 25px')
    expect(css).toContain('padding: 0 20px 74px')
    expect(css).toContain('@media (max-width: 1024px)')
    expect(css).toContain('@media (max-width: 600px)')
    expect(css).toContain('--web-right-panel-width: min(calc(100cqi - var(--web-sidebar-width, 256px)), max(420px, calc((100cqi - var(--web-sidebar-width, 256px)) * 0.44)))')
    expect(css).toContain('grid-template-columns: var(--web-sidebar-width, 256px) minmax(0, 1fr) var(--web-right-panel-width)')
    expect(css).toContain('.web-right-panel { min-width: 0; width: auto; min-height: 0; height: 100%; justify-self: stretch; align-self: stretch;')
    expect(css).not.toContain('.web-right-panel { min-width: 0; width: 100%;')
    expect(app).toContain('Add action')
    expect(app).toContain('desktop only')
    expect(app).toContain('Toggle terminal panel')
    expect(app).toContain('Toggle Diff panel')
  })
})
