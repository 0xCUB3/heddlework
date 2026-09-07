import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { PiSessionSummary } from './session-catalog.ts'

const exec = promisify(execFile)

async function checkoutBranch(cwd: string): Promise<string | undefined> {
  if (!cwd) return undefined
  try {
    // symbolic-ref handles unborn branches and linked worktrees; detached HEAD has no branch label.
    const { stdout } = await exec('git', ['-C', cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { timeout: 2000, maxBuffer: 4096 })
    return stdout.trim() || undefined
  } catch {
    return undefined
  }
}

export async function withSessionBranches(sessions: PiSessionSummary[]): Promise<PiSessionSummary[]> {
  const directories = [...new Set(sessions.map((session) => session.cwd))]
  const branches = new Map<string, string | undefined>()
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, directories.length) }, async () => {
    while (next < directories.length) {
      const cwd = directories[next++]!
      branches.set(cwd, await checkoutBranch(cwd))
    }
  }))
  // Branch metadata is checkout state, not JSONL state. Refresh it even when the session file is unchanged.
  return sessions.map((session) => ({ ...session, branch: branches.get(session.cwd) }))
}
