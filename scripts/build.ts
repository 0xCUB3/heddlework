import { chmodSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dir, '..')
const dist = resolve(root, 'dist')
const output = resolve(dist, process.platform === 'win32' ? 'heddlework.exe' : 'heddlework')

const web = Bun.spawnSync([process.execPath, resolve(root, 'scripts/build-web.ts')], { cwd: root, stdout: 'inherit', stderr: 'inherit' })
if (web.exitCode !== 0) throw new Error('Failed to build the web workspace client')

mkdirSync(dist, { recursive: true })
rmSync(output, { force: true })

const compile: { outfile: string; target?: Bun.Build.CompileTarget } = { outfile: output }
if (process.env.COMPILE_TARGET) compile.target = process.env.COMPILE_TARGET as Bun.Build.CompileTarget

const packageVersion = (JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string }).version
const version = (process.env.HEDDLEWORK_VERSION ?? packageVersion).replace(/^v/, '')

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/main.tsx')],
  compile,
  minify: true,
  sourcemap: 'linked',
  define: { __HEDDLEWORK_VERSION__: JSON.stringify(version) },
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error('Failed to compile Heddlework')
}

if (process.platform !== 'win32') chmodSync(output, 0o755)
// build-web.ts already emits dist/web next to the executable, which is where the desktop looks for the client.
console.log(`Built ${output} (${version})`)
