import { existsSync, mkdirSync, renameSync, rmSync, symlinkSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'

// Builds the Chromium-bundled app from this checkout and installs it as "Heddlework Dev.app" so it can sit beside a
// release install. With --watch, changes under src/, scripts/, or packaging/ rebuild the bundle and relaunch the app.
// Usage: bun scripts/install-dev.ts [--watch] [--no-launch] [--dir <folder>]

const root = resolve(import.meta.dir, '..')
const args = process.argv.slice(2)
const watchMode = args.includes('--watch')
const launch = !args.includes('--no-launch')
const directoryFlag = args.indexOf('--dir')
const installDirectory = resolve(directoryFlag >= 0 && args[directoryFlag + 1] ? args[directoryFlag + 1]! : process.env.HEDDLEWORK_DEV_DIR ?? resolve(homedir(), 'Applications'))
const bundle = resolve(installDirectory, 'Heddlework Dev.app')
const built = resolve(root, 'dist', 'Heddlework Dev.app')
const launcher = resolve(root, 'dist', 'heddlework')

function run(command: string[], env: Record<string, string> = {}): boolean {
  const result = Bun.spawnSync(command, { cwd: root, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, ...env } })
  return result.exitCode === 0
}

function running(): boolean {
  return Bun.spawnSync(['pgrep', '-f', `${bundle}/Contents/MacOS/Heddlework`], { stdout: 'ignore', stderr: 'ignore' }).exitCode === 0
}

function install(): boolean {
  const started = performance.now()
  if (!run([process.execPath, resolve(root, 'scripts/build.ts')], { HEDDLEWORK_DEV_INSTALL: '1' })) {
    console.error('[install-dev] build failed; the installed app is unchanged')
    return false
  }
  const wasRunning = running()
  if (wasRunning) run(['pkill', '-f', `${bundle}/Contents/MacOS/Heddlework`])
  mkdirSync(installDirectory, { recursive: true })
  // Move the finished bundle into place as one rename so Finder and Launch Services never see a half-copied app.
  const previous = `${bundle}.previous`
  rmSync(previous, { recursive: true, force: true })
  if (existsSync(bundle)) renameSync(bundle, previous)
  renameSync(built, bundle)
  rmSync(previous, { recursive: true, force: true })
  // build.ts leaves dist/heddlework pointing into dist/Heddlework.app; retarget it so the launcher keeps working.
  rmSync(launcher, { force: true })
  symlinkSync(resolve(bundle, 'Contents', 'MacOS', 'Heddlework'), launcher)
  console.log(`[install-dev] installed ${bundle} in ${((performance.now() - started) / 1000).toFixed(1)}s`)
  if (launch && (wasRunning || !watchMode || firstRun)) run(['open', '-n', bundle])
  return true
}

let firstRun = true
const ok = install()
firstRun = false
if (!watchMode) process.exit(ok ? 0 : 1)

let timer: ReturnType<typeof setTimeout> | undefined
let busy = false
let pending = false
function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    if (busy) { pending = true; return }
    busy = true
    try { install() } finally {
      busy = false
      if (pending) { pending = false; schedule() }
    }
  }, 400)
}

for (const directory of ['src', 'scripts', 'packaging']) {
  watch(resolve(root, directory), { recursive: true }, (_event, file) => {
    if (file && /(^|\/)(\.|dist\/)/.test(file)) return
    schedule()
  })
}
console.log(`[install-dev] watching src/, scripts/, and packaging/ for changes; the app relaunches after each rebuild`)
