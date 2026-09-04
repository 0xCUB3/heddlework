import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// The compiled web client sits next to the executable in a release, or under dist/web in a source checkout.
export function resolveStaticRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (environment.HEDDLEWORK_WEB_ROOT) return resolve(environment.HEDDLEWORK_WEB_ROOT)
  const candidates = [resolve(dirname(process.execPath), 'web'), resolve(import.meta.dir, '..', '..', 'dist', 'web')]
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')))
}
