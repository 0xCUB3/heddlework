import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

describe('web workspace build', () => {
  it('bundles the browser entry without node: specifiers', async () => {
    const result = await Bun.build({
      entrypoints: [resolve(import.meta.dir, '../src/web/main.tsx')],
      target: 'browser',
      format: 'esm',
      tsconfig: resolve(import.meta.dir, '../src/web/tsconfig.json'),
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
