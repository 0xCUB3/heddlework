import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dir, '..')
const webRoot = resolve(root, 'dist', 'web')

async function rebuild(): Promise<void> {
  const build = spawn(process.execPath, [resolve(root, 'scripts/build-web.ts')], { stdio: 'inherit', cwd: root })
  await new Promise<void>((resolveBuild, reject) => {
    build.on('exit', (code) => code === 0 ? resolveBuild() : reject(new Error(`build-web exited ${code}`)))
  })
}

await rebuild()

process.env.HEDDLEWORK_HOST = process.env.HEDDLEWORK_HOST ?? '1'
process.env.HEDDLEWORK_WEB_ROOT = webRoot

const host = spawn(process.execPath, [resolve(root, 'src/host/main.ts'), ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: root,
  env: process.env,
})

let rebuilding = false
watch(resolve(root, 'src/web'), { recursive: true }, () => {
  if (rebuilding) return
  rebuilding = true
  void rebuild().catch((error) => console.error(error)).finally(() => { rebuilding = false })
})

host.on('exit', (code) => process.exit(code ?? 0))
process.once('SIGINT', () => host.kill('SIGINT'))
process.once('SIGTERM', () => host.kill('SIGTERM'))
