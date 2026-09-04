import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { comparableLanePath, GitCheckoutLanes, laneBranch } from '../src/workspace/checkout-lanes.ts'

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } })
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(err)
  return out
}

async function repo(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'heddlework-lane-repo-'))
  await git(dir, 'init', '-q', '-b', 'main')
  writeFileSync(join(dir, 'README.md'), 'hello\n')
  await git(dir, 'add', '.')
  await git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

describe('checkout lanes', () => {
  it('creates a worktree lane, leaves the primary tree untouched, merges, and removes it', async () => {
    const workspace = await repo()
    const root = mkdtempSync(join(tmpdir(), 'heddlework-lanes-'))
    const lanes = new GitCheckoutLanes(root)
    const lane = await lanes.create(workspace, 'HW-1-1')
    expect(lane.branch).toBe(laneBranch('HW-1-1'))
    expect(existsSync(join(lane.path, 'README.md'))).toBe(true)
    expect((await git(workspace, 'worktree', 'list')).toLowerCase().replace(/\\/g, '/')).toContain(comparableLanePath(lane.path).toLowerCase())
    expect((await lanes.list(workspace)).map((entry) => entry.id)).toEqual(['HW-1-1'])
    const again = await lanes.create(workspace, 'HW-1-1')
    expect(again.branch).toBe(lane.branch)
    expect(comparableLanePath(again.path)).toBe(comparableLanePath(lane.path))

    writeFileSync(join(lane.path, 'lane.txt'), 'from lane\n')
    await git(lane.path, 'add', '.')
    await git(lane.path, 'commit', '-q', '-m', 'lane work')
    expect(existsSync(join(workspace, 'lane.txt'))).toBe(false)
    expect((await git(workspace, 'status', '--porcelain')).trim()).toBe('')

    const merged = await lanes.merge(workspace, 'HW-1-1')
    expect(merged).toEqual({ merged: true })
    expect(readFileSync(join(workspace, 'lane.txt'), 'utf8')).toBe('from lane\n')
    expect(await lanes.list(workspace)).toEqual([])
    expect(existsSync(lane.path)).toBe(false)

    const second = await lanes.create(workspace, 'HW-1-2')
    await lanes.remove(workspace, 'HW-1-2')
    expect(existsSync(second.path)).toBe(false)
    expect(await git(workspace, 'worktree', 'list')).not.toContain('HW-1-2')
    rmSync(workspace, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }, 20_000)

  it('reports a conflict without touching the lane', async () => {
    const workspace = await repo()
    const root = mkdtempSync(join(tmpdir(), 'heddlework-lanes-'))
    const lanes = new GitCheckoutLanes(root)
    const lane = await lanes.create(workspace, 'HW-2-1')
    writeFileSync(join(lane.path, 'README.md'), 'lane version\n')
    await git(lane.path, 'commit', '-q', '-am', 'lane edit')
    writeFileSync(join(workspace, 'README.md'), 'primary version\n')
    await git(workspace, 'commit', '-q', '-am', 'primary edit')
    const result = await lanes.merge(workspace, 'HW-2-1')
    expect(result.merged).toBe(false)
    expect(result.merged === false && result.message).toContain('CONFLICT')
    await git(workspace, 'merge', '--abort')
    expect((await lanes.list(workspace)).map((entry) => entry.id)).toEqual(['HW-2-1'])
    expect(() => lanes.create(workspace, '../evil')).toThrow('Invalid lane id')
    rmSync(workspace, { recursive: true, force: true })
    rmSync(root, { recursive: true, force: true })
  }, 20_000)
})
