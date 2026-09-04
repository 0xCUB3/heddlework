import { describe, expect, it } from 'bun:test'
import { readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { webPrecachePaths } from '../src/web/sw-manifest.ts'

describe('web service worker build', () => {
  it('builds for the browser and precaches the emitted app shell', async () => {
    const build = await piBuild()
    expect(build).toContain('Built')
    const outdir = resolve(import.meta.dir, '../dist/web')
    const files = readdirSync(outdir)
    expect(files).toContain('sw.js')
    expect(files).toContain('manifest.webmanifest')
    expect(files).toContain('icon-192.png')
    const precache = webPrecachePaths(files)
    expect(precache).toContain('/index.html')
    expect(precache).toContain('/main.js')
    expect(precache).toContain('/styles.css')
    expect(precache).toContain('/manifest.webmanifest')
    expect(precache).not.toContain('/sw.js')
    const sw = await Bun.file(resolve(outdir, 'sw.js')).text()
    for (const path of precache) expect(sw).toContain(path)
  }, 30_000)
})

async function piBuild(): Promise<string> {
  const proc = Bun.spawn(['bun', 'scripts/build-web.ts'], { cwd: resolve(import.meta.dir, '..'), stdout: 'pipe', stderr: 'pipe' })
  const text = await new Response(proc.stdout).text()
  const err = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(err || text)
  return text
}
