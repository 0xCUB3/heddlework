import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { serviceToken, type WorkbenchPlugin } from '../core/kernel.ts'

export interface CheckoutLane {
  id: string
  path: string
  branch: string
}

export interface CheckoutLaneService {
  create(workspacePath: string, laneId: string): Promise<CheckoutLane>
  remove(workspacePath: string, laneId: string): Promise<void>
  list(workspacePath: string): Promise<CheckoutLane[]>
  merge(workspacePath: string, laneId: string): Promise<{ merged: true } | { merged: false; message: string }>
}

export const checkoutLaneToken = serviceToken<CheckoutLaneService>('checkout-lanes')

export const LANE_BRANCH_PREFIX = 'heddlework/'

export function laneBranch(laneId: string): string {
  return `${LANE_BRANCH_PREFIX}${laneId}`
}

export function lanesRoot(platform: NodeJS.Platform = process.platform, environment: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Heddlework', 'lanes')
  if (platform === 'win32') return join(environment.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Heddlework', 'lanes')
  return join(environment.XDG_STATE_HOME ?? join(home, '.local', 'state'), 'heddlework', 'lanes')
}

export function lanePath(root: string, workspacePath: string, laneId: string): string {
  const hash = createHash('sha1').update(resolve(workspacePath)).digest('hex').slice(0, 12)
  return join(existsSync(root) ? realpathSync(root) : resolve(root), hash, laneId)
}

// Git worktrees keyed by workspace hash and lane id. The primary working tree is never checked out, reset, or cleaned here.
export class GitCheckoutLanes implements CheckoutLaneService {
  readonly #root: string

  constructor(root: string = lanesRoot()) {
    this.#root = root
  }

  async create(workspacePath: string, laneId: string): Promise<CheckoutLane> {
    assertLaneId(laneId)
    const path = lanePath(this.#root, workspacePath, laneId)
    const branch = laneBranch(laneId)
    const existing = (await this.list(workspacePath)).find((lane) => lane.id === laneId)
    if (existing) return existing
    mkdirSync(resolve(path, '..'), { recursive: true })
    const branches = await runGit(workspacePath, ['branch', '--list', branch])
    const args = branches.trim() ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path]
    await runGit(workspacePath, args)
    return { id: laneId, path, branch }
  }

  async remove(workspacePath: string, laneId: string): Promise<void> {
    assertLaneId(laneId)
    const path = lanePath(this.#root, workspacePath, laneId)
    if (existsSync(path)) await runGit(workspacePath, ['worktree', 'remove', '--force', path])
    await runGit(workspacePath, ['worktree', 'prune'])
  }

  async list(workspacePath: string): Promise<CheckoutLane[]> {
    const output = await runGit(workspacePath, ['worktree', 'list', '--porcelain'])
    const lanes: CheckoutLane[] = []
    let current: { path?: string; branch?: string } = {}
    const flush = (): void => {
      if (current.path && current.branch?.startsWith(`refs/heads/${LANE_BRANCH_PREFIX}`)) {
        const branch = current.branch.slice('refs/heads/'.length)
        lanes.push({ id: branch.slice(LANE_BRANCH_PREFIX.length), path: current.path, branch })
      }
      current = {}
    }
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) { flush(); current.path = line.slice('worktree '.length) }
      else if (line.startsWith('branch ')) current.branch = line.slice('branch '.length)
      else if (line === '') flush()
    }
    flush()
    return lanes
  }

  async merge(workspacePath: string, laneId: string): Promise<{ merged: true } | { merged: false; message: string }> {
    assertLaneId(laneId)
    try {
      await runGit(workspacePath, ['merge', '--no-ff', '--no-edit', laneBranch(laneId)])
    } catch (error) {
      return { merged: false, message: error instanceof Error ? error.message : String(error) }
    }
    await this.remove(workspacePath, laneId)
    await runGit(workspacePath, ['branch', '-D', laneBranch(laneId)]).catch(() => undefined)
    return { merged: true }
  }
}

export function createCheckoutLanePlugin(root?: string): WorkbenchPlugin {
  return {
    id: 'checkout-lanes',
    activate(ctx) {
      ctx.provide(checkoutLaneToken, new GitCheckoutLanes(root))
    },
  }
}

const identityCache = new Map<string, boolean>()

async function hasGitIdentity(cwd: string): Promise<boolean> {
  const cached = identityCache.get(cwd)
  if (cached !== undefined) return cached
  const child = Bun.spawn(['git', 'config', 'user.email'], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited])
  const present = exitCode === 0 && stdout.trim().length > 0 || Boolean(process.env.GIT_COMMITTER_EMAIL)
  identityCache.set(cwd, present)
  return present
}

function assertLaneId(laneId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(laneId)) throw new Error(`Invalid lane id: ${laneId}`)
}

// Merge commits need an identity; hosts without git config still get a deterministic one so the lane merge does not fail on identity alone.
const FALLBACK_IDENTITY = {
  GIT_AUTHOR_NAME: 'Heddlework',
  GIT_AUTHOR_EMAIL: 'heddlework@localhost',
  GIT_COMMITTER_NAME: 'Heddlework',
  GIT_COMMITTER_EMAIL: 'heddlework@localhost',
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const identity = await hasGitIdentity(cwd) ? {} : FALLBACK_IDENTITY
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...identity, ...process.env, GIT_EDITOR: 'true' } })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `git ${args[0] ?? ''} exited with ${exitCode}`)
  return stdout
}
