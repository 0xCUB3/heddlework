export const GIT_STDERR_MAX_BYTES = 64_000

export class ByteBudget {
  #used = 0

  constructor(readonly maxBytes: number) {}

  get used(): number {
    return this.#used
  }

  get remaining(): number {
    return Math.max(0, this.maxBytes - this.#used)
  }

  get exceeded(): boolean {
    return this.#used > this.maxBytes
  }

  consume(bytes: number): void {
    this.#used += bytes
  }
}

export function abortError(message = 'Diff cancelled.'): Error {
  const error = new Error(message)
  error.name = 'AbortError'
  return error
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

function abortSignal(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError())
      return
    }
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })
}

export interface BoundedReadResult {
  text: string
  bytesRead: number
  truncated: boolean
}

export async function readBoundedText(
  stream: ReadableStream<Uint8Array> | undefined | null,
  options: { maxBytes?: number; budget?: ByteBudget; signal?: AbortSignal } = {},
): Promise<BoundedReadResult> {
  if (!stream) return { text: '', bytesRead: 0, truncated: false }
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  const overLimit = (): boolean => {
    if (options.budget) return options.budget.exceeded
    return bytesRead > (options.maxBytes ?? Number.MAX_SAFE_INTEGER)
  }
  const onAbort = (): void => {
    void reader.cancel().catch(() => { /* already closed */ })
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    if (options.signal?.aborted) throw abortError()
    const cancelReader = (): void => {
      void reader.cancel().catch(() => { /* already closed */ })
    }
    if (overLimit()) {
      cancelReader()
      return { text: '', bytesRead, truncated: true }
    }
    const aborted = options.signal ? abortSignal(options.signal) : undefined
    while (true) {
      if (options.signal?.aborted) throw abortError()
      if (overLimit()) {
        cancelReader()
        return { text: '', bytesRead, truncated: true }
      }
      const { done, value } = aborted
        ? await Promise.race([reader.read(), aborted])
        : await reader.read()
      if (done) {
        if (options.signal?.aborted) throw abortError()
        break
      }
      if (!value || value.byteLength === 0) continue
      bytesRead += value.byteLength
      options.budget?.consume(value.byteLength)
      if (overLimit()) {
        cancelReader()
        return { text: '', bytesRead, truncated: true }
      }
      chunks.push(value)
    }
    return { text: Buffer.concat(chunks).toString('utf8'), bytesRead, truncated: false }
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw abortError()
    throw error
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    void reader.cancel().catch(() => { /* already closed */ })
  }
}

export interface CancellableChild {
  kill: () => void
}

export class DiffJob<T> {
  readonly #abort = new AbortController()
  readonly #children = new Set<CancellableChild>()
  readonly result: Promise<T>
  #cancelled = false

  constructor(run: (job: DiffJob<T>) => Promise<T>, signal?: AbortSignal) {
    if (signal) {
      if (signal.aborted) this.cancel()
      else signal.addEventListener('abort', () => this.cancel(), { once: true })
    }
    this.result = Promise.resolve().then(() => run(this))
  }

  get signal(): AbortSignal {
    return this.#abort.signal
  }

  get cancelled(): boolean {
    return this.#cancelled
  }

  addChild(child: CancellableChild): void {
    this.#children.add(child)
  }

  cancel(): void {
    if (this.#cancelled) return
    this.#cancelled = true
    this.#abort.abort()
    for (const child of this.#children) {
      try { child.kill() } catch { /* already exited */ }
    }
  }
}

export interface SpawnGitResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
  bytesRead: number
}

export async function spawnCancellableGit(options: {
  cwd: string
  args: readonly string[]
  allowedExitCodes?: readonly number[]
  signal?: AbortSignal
  budget?: ByteBudget
  maxBytes?: number
  onSpawn?: (child: CancellableChild) => void
}): Promise<SpawnGitResult> {
  if (options.signal?.aborted) throw abortError()
  if (options.budget?.exceeded) {
    return { stdout: '', stderr: '', exitCode: 0, truncated: true, bytesRead: 0 }
  }
  const child = Bun.spawn(['git', ...options.args], { cwd: options.cwd, stdout: 'pipe', stderr: 'pipe' })
  options.onSpawn?.(child)
  const onAbort = (): void => {
    try { child.kill() } catch { /* already exited */ }
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const bound = {
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.budget ? { budget: options.budget } : { maxBytes: options.maxBytes ?? Number.MAX_SAFE_INTEGER }),
    }
    const stdoutTask = readBoundedText(child.stdout, bound).then((result) => {
      if (result.truncated) {
        try { child.kill() } catch { /* already exited */ }
      }
      return result
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      stdoutTask,
      readBoundedText(child.stderr, { ...(options.signal ? { signal: options.signal } : {}), maxBytes: GIT_STDERR_MAX_BYTES }),
      child.exited,
    ])
    if (options.signal?.aborted) throw abortError()
    if (stdout.truncated) {
      try { child.kill() } catch { /* already exited */ }
      return { stdout: '', stderr: stderr.text, exitCode, truncated: true, bytesRead: stdout.bytesRead }
    }
    const allowed = options.allowedExitCodes ?? [0]
    if (!allowed.includes(exitCode)) {
      throw new Error(stderr.text.trim() || `git ${options.args[0] ?? ''} exited with ${exitCode}`)
    }
    return { stdout: stdout.text, stderr: stderr.text, exitCode, truncated: false, bytesRead: stdout.bytesRead }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
  }
}
