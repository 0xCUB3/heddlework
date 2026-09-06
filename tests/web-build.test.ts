import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { webAliasPlugin } from '../scripts/web-aliases.ts'

describe('web workspace build', () => {
  it('bundles the browser entry without node: specifiers', async () => {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../src/web/main.tsx')],
      target: 'browser',
      format: 'esm',
      tsconfig: resolve(import.meta.dir, '../src/web/tsconfig.json'),
      define: { 'process.env.NODE_ENV': '"production"', 'process.platform': '__hwPlatform', 'process.env.HEDDLEWORK_ADVERTISE': 'undefined' },
      plugins: [webAliasPlugin(resolve(import.meta.dir, '..'))],
      jsx: { runtime: 'automatic', importSource: '@gpuix/react' },
    })
    const failures = result.logs.filter((log) => log.level === 'error').map((log) => log.message)
    expect(failures).toEqual([])
    expect(result.success).toBe(true)
    for (const output of result.outputs) {
      const text = await output.text()
      expect([...text.matchAll(/from\s*["']node:[^"']+["']/g)].map((match) => match[0])).toEqual([])
    }
  }, 30_000)
})
