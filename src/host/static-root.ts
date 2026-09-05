import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

// The compiled web client sits in Contents/Resources/web inside a macOS bundle (codesign rejects data under
// Contents/MacOS), next to the executable on Linux and Windows, or under dist/web in a source checkout.
export function resolveStaticRoot(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  if (environment.HEDDLEWORK_WEB_ROOT) return resolve(environment.HEDDLEWORK_WEB_ROOT)
  const executableDirectory = dirname(process.execPath)
  const candidates = [
    resolve(executableDirectory, '..', 'Resources', 'web'),
    resolve(executableDirectory, 'web'),
    resolve(import.meta.dir, '..', '..', 'dist', 'web'),
  ]
  return candidates.find((candidate) => existsSync(resolve(candidate, 'index.html')))
}
