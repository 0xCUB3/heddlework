import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostTokenPath } from '../host/token.ts'

declare const __HEDDLEWORK_RUNTIME_CHANNEL__: string | undefined

export function runtimeDirectory(environment: NodeJS.ProcessEnv = process.env): string {
  if (environment.HEDDLEWORK_RUNTIME_DIR) return environment.HEDDLEWORK_RUNTIME_DIR
  const channel = typeof __HEDDLEWORK_RUNTIME_CHANNEL__ === 'string' ? __HEDDLEWORK_RUNTIME_CHANNEL__ : 'dev'
  return join(dirname(hostTokenPath(process.platform, environment)), channel === 'dev' ? 'runtime-dev' : 'runtime')
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(path, 0o700)
}

export function writePrivateJson(path: string, value: unknown): void {
  privateDirectory(dirname(path))
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

export interface RuntimeDescriptor {
  pid: number
  instanceId: string
  protocol: number
  version: string
  executable: string
  url: string
  controlUrl: string
  token: string
  workspacePath: string
  supervisor: 'launchd' | 'process'
}
