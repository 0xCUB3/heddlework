import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { attachOrStartRuntime, RuntimeUpgradeDeferredError } from '../src/runtime/bootstrap.ts'

function isDeferredUpgrade(error: unknown): boolean {
  if (error instanceof RuntimeUpgradeDeferredError) return true
  const message = error instanceof Error ? error.message : String(error)
  return /runtime update will wait/u.test(message)
    || /update will wait until agents stop/u.test(message)
    || /protocol \d+; this app uses \d+/u.test(message)
}

const bundle = resolve(process.argv[2] ?? resolve(homedir(), 'Applications/Heddlework Dev.app'))
try {
  const descriptor = await attachOrStartRuntime({
    workspacePath: homedir(),
    executable: resolve(bundle, 'Contents/Resources/runtime/heddlework-runtime'),
    refresh: true,
  })
  console.log(`[dev-runtime] ready: pid ${descriptor.pid}, version ${descriptor.version}, protocol ${descriptor.protocol}`)
} catch (error) {
  if (isDeferredUpgrade(error)) {
    console.log(`[dev-runtime] deferred: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(0)
  }
  throw error
}
