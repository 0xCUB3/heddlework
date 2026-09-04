import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { webPrecachePaths } from '../src/web/sw-manifest.ts'

const root = resolve(import.meta.dir, '..')
const outdir = resolve(root, 'dist', 'web')

rmSync(outdir, { recursive: true, force: true })
mkdirSync(outdir, { recursive: true })

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/web/main.tsx')],
  outdir,
  target: 'browser',
  minify: true,
  sourcemap: 'linked',
  format: 'esm',
  tsconfig: resolve(root, 'src/web/tsconfig.json'),
  define: { 'process.env.NODE_ENV': '"production"' },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error('Failed to build the web workspace client')
}

for (const file of ['index.html', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png']) {
  copyFileSync(resolve(root, 'src/web', file), resolve(outdir, file))
}

const assets = readdirSync(outdir)
const hash = createHash('sha256').update(assets.sort().join('\n')).digest('hex').slice(0, 12)
const precache = webPrecachePaths(assets)
const sw = await Bun.build({
  entrypoints: [resolve(root, 'src/web/sw.ts')],
  outdir,
  target: 'browser',
  minify: true,
  format: 'esm',
  naming: 'sw.js',
  define: {
    __HEDDLEWORK_BUILD_HASH__: JSON.stringify(hash),
    __HEDDLEWORK_PRECACHE__: JSON.stringify(precache),
  },
})

if (!sw.success) {
  for (const log of sw.logs) console.error(log)
  throw new Error('Failed to build the web service worker')
}

console.log(`Built ${outdir}`)
