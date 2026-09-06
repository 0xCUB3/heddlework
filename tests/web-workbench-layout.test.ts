// The web bundle mounts the shared WorkbenchApp through the DOM host, so parity is a property of that path,
// not of the legacy src/web/app.tsx tree.
import { describe, expect, it } from 'bun:test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import uiContract from '../src/workbench/ui-contract.json'
import { paletteToCssProperties } from '../src/web/theme.ts'

const root = resolve(import.meta.dir, '..')

describe('web workbench layout parity', () => {
  it('mounts the shared WorkbenchApp through the DOM host', async () => {
    const main = await readFile(resolve(root, 'src/web/main.tsx'), 'utf8')
    const workbench = await readFile(resolve(root, 'src/web/workbench.tsx'), 'utf8')
    expect(main).toContain("from './workbench.tsx'")
    expect(workbench).toContain("from '../ui/app.tsx'")
    expect(workbench).toContain("from '../dom/host.tsx'")
    expect(workbench).not.toContain("from './app.tsx'")
  })

  it('pages older history from the shared transcript instead of a web-only button', async () => {
    const workbench = await readFile(resolve(root, 'src/web/workbench.tsx'), 'utf8')
    const app = await readFile(resolve(root, 'src/ui/app.tsx'), 'utf8')
    expect(workbench).not.toContain('Load earlier')
    expect(app).toContain('onLoadEarlier={controller.loadEarlierMessages}')
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
})
