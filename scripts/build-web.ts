import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

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

for (const file of ['index.html', 'styles.css', 'manifest.webmanifest']) {
  copyFileSync(resolve(root, 'src/web', file), resolve(outdir, file))
}

console.log(`Built ${outdir}`)
