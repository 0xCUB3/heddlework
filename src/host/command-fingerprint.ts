import { createHash } from 'node:crypto'
import type { WorkbenchCommand } from '../protocol/commands.ts'

export function commandAdmissionFingerprint(command: WorkbenchCommand, sessionKey?: string | undefined): string {
  const payload = JSON.stringify({ sessionKey: sessionKey ?? null, command })
  return createHash('sha256').update(payload).digest('hex').slice(0, 32)
}
