import { afterEach, expect, it } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { serializeSnapshot } from '../src/protocol/snapshot.ts'
import { createInitialState } from '../src/workbench/state.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' })

it('resolves each checkout independently of the active workspace, including worktrees and unchanged session files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hw-session-branches-'))
  roots.push(root)
  const a = join(root, 'a'), b = join(root, 'b'), worktree = join(root, 'worktree'), plain = join(root, 'plain')
  await Promise.all([a, b, plain].map(path => mkdir(path)))
  git(a, 'init', '-b', 'main')
  git(a, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'initial')
  git(a, 'worktree', 'add', '-b', 'feature/thread', worktree)
  git(b, 'init', '-b', 'develop')
  const options = { agentDir: join(root, 'agent'), cachePath: join(root, 'cache.json') }
  const catalog = new PiSessionCatalog(options)
  for (const cwd of [a, b, worktree, plain, join(root, 'missing')]) await catalog.createWorkspaceSession(cwd)
  const branches = (sessions: Awaited<ReturnType<typeof catalog.list>>) => Object.fromEntries(sessions.map(s => [s.cwd, s.branch]))
  const first = await catalog.list(a)
  expect(branches(first)).toEqual({ [a]: 'main', [b]: 'develop', [worktree]: 'feature/thread', [plain]: undefined, [join(root, 'missing')]: undefined })
  expect(branches(await catalog.list(b))).toEqual(branches(first))
  expect(branches(new PiSessionCatalog(options).cached(b))).toEqual(branches(first))
  const wire = JSON.parse(JSON.stringify(serializeSnapshot({ ...createInitialState(b), sessions: first })))
  expect(branches(wire.sessions)).toEqual(branches(first))
  git(a, 'checkout', '-b', 'next')
  expect(branches(await catalog.list(b))[a]).toBe('next')
  git(a, 'checkout', '--detach')
  const detached = branches(await catalog.list(b))
  expect(detached[a]).toBeUndefined()
  expect(detached[worktree]).toBe('feature/thread')
})
