import { describe, expect, it } from 'bun:test'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')

describe('image hydration worker packaging', () => {
  it('compiled probe hydrates on a worker away from the source tree', async () => {
    const work = mkdtempSync(join(tmpdir(), 'hw-image-hydrate-compile-'))
    const away = mkdtempSync(join(tmpdir(), 'hw-image-hydrate-away-'))
    try {
      const outfile = join(work, 'probe')
      const result = await Bun.build({
        entrypoints: [
          resolve(root, 'scripts/probe-image-hydration.ts'),
          resolve(root, 'src/ui/image-hydration-worker.ts'),
        ],
        compile: { outfile },
        minify: true,
      })
      expect(result.success).toBe(true)

      const compiled = existsSync(outfile) ? outfile : `${outfile}.exe`
      const binary = join(away, process.platform === 'win32' ? 'probe.exe' : 'probe')
      copyFileSync(compiled, binary)
      chmodSync(binary, 0o755)
      if (process.platform === 'darwin') {
        const signed = Bun.spawnSync(['codesign', '--force', '--sign', '-', '--timestamp=none', binary], {
          stdout: 'ignore',
          stderr: 'pipe',
        })
        expect(signed.exitCode).toBe(0)
      }

      const run = Bun.spawnSync([binary], { cwd: away, stdout: 'pipe', stderr: 'pipe' })
      const stdout = run.stdout.toString().trim()
      expect(run.exitCode).toBe(0)
      const parsed = JSON.parse(stdout) as { backend: string; bytesEqual: boolean; size: number; compiled: boolean }
      expect(parsed).toMatchObject({ backend: 'worker', bytesEqual: true, compiled: true })
      expect(parsed.size).toBeGreaterThan(0)
    } finally {
      rmSync(work, { recursive: true, force: true })
      rmSync(away, { recursive: true, force: true })
    }
  }, 60_000)
})
