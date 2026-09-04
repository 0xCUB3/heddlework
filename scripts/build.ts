import { chmodSync, mkdirSync, rmSync } from 'node:fs'
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

const result = await Bun.build({
  entrypoints: [resolve(root, 'src/main.tsx')],
  compile,
  minify: true,
  sourcemap: 'linked',
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  throw new Error('Failed to compile Heddlework')
}

if (process.platform !== 'win32') chmodSync(output, 0o755)
console.log(`Built ${output}`)
