import type { WorkspaceDiff, WorkspaceDiffFile } from '../workbench/state.ts'
import { abortError, ByteBudget, DiffJob, isAbortError, spawnCancellableGit } from './diff-job.ts'

export const MAX_PATCH_BYTES = 1_500_000
const MAX_UNTRACKED_FILES = 24
const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

export { DiffJob, readBoundedText } from './diff-job.ts'

export function startWorkspaceDiffJob(
  cwd: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): DiffJob<WorkspaceDiff> {
  const maxBytes = options.maxBytes ?? MAX_PATCH_BYTES
  return new DiffJob(async (job) => {
    try {
      return await collectWorkspaceDiff(cwd, job, maxBytes)
    } catch (error) {
      if (job.cancelled || isAbortError(error)) return errorDiff('Diff cancelled.')
      return errorDiff(error instanceof Error ? error.message : String(error))
    }
  }, options.signal)
}

export async function loadWorkspaceDiff(
  cwd: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {},
): Promise<WorkspaceDiff> {
  return startWorkspaceDiffJob(cwd, options).result
}

export class SharedWorkspaceDiffLoader {
  readonly #jobs = new Map<string, { job: DiffJob<WorkspaceDiff>; subscribers: number }>()

  load(workspacePath: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<WorkspaceDiff> {
    const existing = this.#jobs.get(workspacePath)
    if (existing && !existing.job.cancelled) {
      existing.subscribers += 1
      return this.#subscribe(workspacePath, existing, options.signal)
    }
    existing?.job.cancel()
    const job = startWorkspaceDiffJob(workspacePath, options)
    const entry = { job, subscribers: 1 }
    this.#jobs.set(workspacePath, entry)
    void job.result.finally(() => {
      if (this.#jobs.get(workspacePath) === entry) this.#jobs.delete(workspacePath)
    })
    return this.#subscribe(workspacePath, entry, options.signal)
  }

  #subscribe(workspacePath: string, entry: { job: DiffJob<WorkspaceDiff>; subscribers: number }, signal?: AbortSignal): Promise<WorkspaceDiff> {
    if (!signal) return entry.job.result
    return new Promise((resolve, reject) => {
      let settled = false
      const onAbort = () => {
        if (settled) return
        settled = true
        entry.subscribers -= 1
        if (entry.subscribers <= 0) {
          entry.job.cancel()
          this.#jobs.delete(workspacePath)
        }
        reject(abortError())
      }
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
      void entry.job.result.then(
        (value) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', onAbort)
          reject(error)
        },
      )
    })
  }

  cancel(workspacePath?: string): void {
    if (workspacePath) {
      this.#jobs.get(workspacePath)?.job.cancel()
      this.#jobs.delete(workspacePath)
      return
    }
    for (const [key, entry] of this.#jobs) {
      entry.job.cancel()
      this.#jobs.delete(key)
    }
  }
}

async function collectWorkspaceDiff(cwd: string, job: DiffJob<WorkspaceDiff>, maxBytes: number): Promise<WorkspaceDiff> {
  if (job.cancelled) return errorDiff('Diff cancelled.')
  const budget = new ByteBudget(maxBytes)
  const git = (
    args: readonly string[],
    extra: { allowedExitCodes?: readonly number[]; budget?: ByteBudget; maxBytes?: number } = {},
  ) => spawnCancellableGit({
    cwd,
    args,
    signal: job.signal,
    onSpawn: (child) => job.addChild(child),
    ...(extra.allowedExitCodes ? { allowedExitCodes: extra.allowedExitCodes } : {}),
    ...(extra.budget ? { budget: extra.budget } : { maxBytes: extra.maxBytes ?? 256_000 }),
  })

  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  if (job.cancelled) return errorDiff('Diff cancelled.', branch)

  const tracked = await git(['diff', '--no-ext-diff', '--unified=3', 'HEAD', '--'], { budget })
  if (tracked.truncated || budget.exceeded) return tooLarge(branch)
  if (job.cancelled) return errorDiff('Diff cancelled.', branch)

  const numstat = await git(['diff', '--numstat', 'HEAD', '--'])
  if (job.cancelled) return errorDiff('Diff cancelled.', branch)

  const untracked = (await git(['ls-files', '--others', '--exclude-standard', '--'])).stdout
    .split('\n')
    .map((path) => path.trim())
    .filter(Boolean)
    .slice(0, MAX_UNTRACKED_FILES)

  const untrackedPatches: string[] = []
  for (const path of untracked) {
    if (job.cancelled) return errorDiff('Diff cancelled.', branch)
    if (budget.exceeded) return tooLarge(branch)
    const result = await git(
      ['diff', '--no-index', '--no-ext-diff', '--unified=3', '--', NULL_DEVICE, path],
      { allowedExitCodes: [0, 1], budget },
    )
    if (result.truncated || budget.exceeded) return tooLarge(branch)
    if (result.stdout) untrackedPatches.push(normalizeNoIndexPatch(result.stdout, cwd, path))
  }

  const patch = [tracked.stdout, ...untrackedPatches].filter(Boolean).join('\n')
  if (Buffer.byteLength(patch, 'utf8') > maxBytes) return tooLarge(branch)

  const stats = parseNumstat(numstat.stdout)
  const files = parsePatchFiles(patch, stats)
  return {
    status: 'ready',
    branch,
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  }
}

function tooLarge(branch = ''): WorkspaceDiff {
  return errorDiff('Working tree diff is too large to render.', branch)
}

function errorDiff(error: string, branch = ''): WorkspaceDiff {
  return {
    status: 'error',
    branch,
    files: [],
    additions: 0,
    deletions: 0,
    error,
  }
}

function parseNumstat(value: string): Map<string, { additions: number; deletions: number }> {
  const stats = new Map<string, { additions: number; deletions: number }>()
  for (const line of value.split('\n')) {
    const [added, deleted, path] = line.split('\t')
    if (!path) continue
    stats.set(path, {
      additions: Number.isFinite(Number(added)) ? Number(added) : 0,
      deletions: Number.isFinite(Number(deleted)) ? Number(deleted) : 0,
    })
  }
  return stats
}

function parsePatchFiles(
  patch: string,
  stats: Map<string, { additions: number; deletions: number }>,
): WorkspaceDiffFile[] {
  return patch
    .split(/(?=^diff --git )/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean)
    .map((chunk) => {
      const path = patchPath(chunk)
      const stat = stats.get(path) ?? lineStats(chunk)
      return { path, patch: `${chunk}\n`, ...stat }
    })
}

function patchPath(patch: string): string {
  const destination = patch.match(/^\+\+\+ b\/(.+)$/m)?.[1]
  if (destination) return unquotePath(destination)
  const header = patch.match(/^diff --git a\/(.+) b\/(.+)$/m)?.[2]
  return unquotePath(header ?? 'changed file')
}

function unquotePath(value: string): string {
  return value.replace(/^"|"$/g, '')
}

function lineStats(patch: string): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const line of patch.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions += 1
    if (line.startsWith('-') && !line.startsWith('---')) deletions += 1
  }
  return { additions, deletions }
}

function normalizeNoIndexPatch(patch: string, cwd: string, path: string): string {
  const escapedCwd = cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return patch
    .replace(new RegExp(`a/${escapedCwd}/?`, 'g'), 'a/')
    .replace(new RegExp(`b/${escapedCwd}/?`, 'g'), 'b/')
    .replace(/^diff --git a\/dev\/null b\/.+$/m, `diff --git a/${path} b/${path}`)
}
