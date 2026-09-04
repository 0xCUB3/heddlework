import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'

// Guards the renderer-neutral layer that the web and mobile clients bundle for the browser.
const SHARED_ENTRYPOINTS = [
  'src/protocol/index.ts',
  'src/flows/types.ts',
  'src/flows/projection.ts',
  'src/flows/fabric-projection.ts',
  'src/ui/transcript-projection.ts',
  'src/workbench/queue.ts',
  'src/workbench/state.ts',
  'src/workbench/timeline.ts',
  'src/workbench/thread-lifecycle.ts',
]

describe('browser-safe shared layer', () => {
  it('bundles for the browser target without node: specifiers', async () => {
    const result = await Bun.build({
      entrypoints: SHARED_ENTRYPOINTS.map((entry) => resolve(import.meta.dir, '..', entry)),
      target: 'browser',
      format: 'esm',
    })
    const failures = result.logs.filter((log) => log.level === 'error').map((log) => log.message)
    expect(failures).toEqual([])
    expect(result.success).toBe(true)
    for (const output of result.outputs) {
      const text = await output.text()
      const nodeImports = [...text.matchAll(/from\s*["']node:[^"']+["']/g)].map((match) => match[0])
      expect(nodeImports).toEqual([])
    }
  }, 30_000)
})
