import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { abortError, DiffJob, readBoundedText } from '../src/workspace/diff-job.ts'
import { loadWorkspaceDiff, SharedWorkspaceDiffLoader, startWorkspaceDiffJob } from '../src/workspace/git-diff.ts'

const directories: string[] = []
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('loadWorkspaceDiff', () => {
  it('loads tracked and untracked working tree patches without a shell', async () => {
    const directory = await seedRepo()
    writeFileSync(join(directory, 'README.md'), '# Fixture\n\nUpdated.\n')
    writeFileSync(join(directory, 'src', 'new.ts'), 'export const ready = true\n')

    const diff = await loadWorkspaceDiff(directory)

    expect(diff.status).toBe('ready')
    expect(diff.branch).toBe('main')
    expect(diff.files.map((file) => file.path).sort()).toEqual(['README.md', 'src/new.ts'])
    expect(diff.additions).toBeGreaterThanOrEqual(3)
    expect(diff.deletions).toBe(0)
    expect(diff.files.find((file) => file.path === 'src/new.ts')?.patch).toContain('export const ready')
  })

  it('caps git output while reading instead of slurping a huge patch', async () => {
    let pulls = 0
    const chunk = new Uint8Array(1000)
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        if (pulls > 10) {
          controller.error(new Error('read too far'))
          return
        }
        controller.enqueue(chunk)
      },
    })

    const bounded = await readBoundedText(stream, { maxBytes: 2500 })
    expect(bounded.truncated).toBe(true)
    expect(bounded.text).toBe('')
    expect(bounded.bytesRead).toBe(3000)
    expect(pulls).toBeLessThanOrEqual(4)

    const directory = await seedRepo()
    writeFileSync(join(directory, 'README.md'), `# Fixture\n${'x'.repeat(40_000)}\n`)
    const diff = await loadWorkspaceDiff(directory, { maxBytes: 8_000 })
    expect(diff.status).toBe('error')
    expect(diff.error).toMatch(/too large/)
    expect(diff.files).toEqual([])
  })

  it('stops a cancelled diff job before git work continues', async () => {
    const directory = await seedRepo()
    writeFileSync(join(directory, 'README.md'), '# Fixture\n\nUpdated.\n')

    const job = startWorkspaceDiffJob(directory)
    job.cancel()
    const diff = await job.result
    expect(job.cancelled).toBe(true)
    expect(diff.status).toBe('error')
    expect(diff.error).toMatch(/cancel/i)
  })

  it('aborts a bounded reader without waiting for the producer to finish', async () => {
    const abort = new AbortController()
    const hanging = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        try { controller.enqueue(new Uint8Array(32)) } catch { /* cancelled */ }
      },
    })
    const pending = readBoundedText(hanging, { maxBytes: 1_000_000, signal: abort.signal })
    await new Promise((resolve) => setTimeout(resolve, 5))
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('does not continue DiffJob work after cancel', async () => {
    let continued = false
    const stalled = new DiffJob(async (current) => {
      await new Promise<never>((_, reject) => {
        if (current.cancelled || current.signal.aborted) {
          reject(abortError())
          return
        }
        current.signal.addEventListener('abort', () => reject(abortError()), { once: true })
      })
      continued = true
      return 'done'
    })
    stalled.cancel()
    await expect(stalled.result).rejects.toMatchObject({ name: 'AbortError' })
    expect(continued).toBe(false)
    expect(stalled.cancelled).toBe(true)
  })

  it('shares an in-flight load for the same workspace and cancels the shared job', async () => {
    const directory = await seedRepo()
    writeFileSync(join(directory, 'README.md'), '# Fixture\n\nUpdated.\n')
    const loader = new SharedWorkspaceDiffLoader()
    const first = loader.load(directory)
    const second = loader.load(directory)
    expect(await first).toEqual(await second)
    loader.cancel(directory)
    const cancelled = new SharedWorkspaceDiffLoader()
    const job = cancelled.load(directory)
    cancelled.cancel(directory)
    const diff = await job
    expect(diff.status === 'error' || diff.status === 'ready').toBe(true)
  })
})

async function seedRepo(): Promise<string> {
  const directory = mkdtempSync(join(tmpdir(), 'heddlework-diff-'))
  directories.push(directory)
  mkdirSync(join(directory, 'src'))
  writeFileSync(join(directory, 'README.md'), '# Fixture\n')
  await run(directory, ['git', 'init', '-q'])
  await run(directory, ['git', 'add', '.'])
  await run(directory, ['git', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'test: seed fixture'])
  await run(directory, ['git', 'branch', '-M', 'main'])
  return directory
}

async function run(cwd: string, command: string[]): Promise<void> {
  const process = Bun.spawn(command, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stderr, exitCode] = await Promise.all([new Response(process.stderr).text(), process.exited])
  if (exitCode !== 0) throw new Error(stderr)
}
