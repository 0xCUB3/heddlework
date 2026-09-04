import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { workbenchUiHostPlugin, workbenchUiRegistryToken } from '../src/ui/extensions.ts'
import { discoverPlugins } from '../src/plugins/discovery.ts'
import { loadExternalPlugins } from '../src/plugins/loader.ts'

const temps: string[] = []

afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function writePlugin(root: string, name: string, manifest: Record<string, unknown>, entry: string): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'heddlework-plugin.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'index.ts'), entry)
  return dir
}

const validEntry = [
  'export default function examplePlugin(api) {',
  '  return {',
  "    id: 'example.hello',",
  '    requires: [api.workbenchUiRegistryToken],',
  '    activate(ctx) {',
  '      ctx.effect(() => ctx.get(api.workbenchUiRegistryToken).register({',
  "        id: 'example.hello',",
  '        surfaces: [{',
  "          id: 'example.hello.panel',",
  "          title: 'Hello',",
  "          description: 'Example external surface.',",
  "          icon: 'panel',",
  '          component: () => null,',
  '        }],',
  '      }))',
  '    },',
  '  }',
  '}',
  '',
].join('\n')

describe('external plugin discovery', () => {
  it('discovers plugins, mounts compatible ones, and reports the rest', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-plugins-'))
    temps.push(root)
    writePlugin(root, 'valid', {
      id: 'example.hello',
      name: 'Hello',
      version: '1.0.0',
      entry: 'index.ts',
      heddlework: { api: '1' },
    }, validEntry)
    writePlugin(root, 'incompatible', {
      id: 'example.two',
      name: 'Two',
      version: '2.0.0',
      entry: 'index.ts',
      heddlework: { api: '2' },
    }, 'export default { id: "example.two", activate() {} }\n')
    writePlugin(root, 'throws', {
      id: 'example.boom',
      name: 'Boom',
      version: '1.0.0',
      entry: 'index.ts',
      heddlework: { api: '1' },
    }, 'export default function boom() { throw new Error("plugin exploded") }\n')

    const discovered = discoverPlugins([{ root, source: 'state' }])
    expect(discovered).toHaveLength(3)

    const kernel = new WorkbenchKernel()
    kernel.mount(workbenchUiHostPlugin)
    const { report } = await loadExternalPlugins(kernel, discovered, { workspaceTrusted: true })
    expect(report.entries.map((entry) => [entry.id, entry.status]).sort()).toEqual([
      ['example.boom', 'error'],
      ['example.hello', 'loaded'],
      ['example.two', 'incompatible'],
    ])
    expect(report.entries.find((entry) => entry.id === 'example.boom')?.error).toContain('plugin exploded')
    expect(kernel.get(workbenchUiRegistryToken).getSnapshot().surfaces.map((surface) => surface.id)).toEqual(['example.hello.panel'])

    await kernel.dispose()
    expect(() => kernel.get(workbenchUiRegistryToken)).toThrow('Missing service: workbench-ui-registry')
  })
})
