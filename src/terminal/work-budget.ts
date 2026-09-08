export const TERMINAL_TURN_BUDGET_MS = 8
export const TERMINAL_TURN_BUDGET_BYTES = 256 * 1024

export interface TerminalTurnBudget {
  readonly maxBytes: number
  readonly maxMs: number
  readonly usedBytes: number
  readonly usedMs: number
  readonly exhausted: boolean
  beginTurn(): void
  consume(bytes: number, elapsedMs?: number): boolean
}

export function createTerminalTurnBudget(options: { maxBytes?: number; maxMs?: number } = {}): TerminalTurnBudget {
  const maxBytes = options.maxBytes ?? TERMINAL_TURN_BUDGET_BYTES
  const maxMs = options.maxMs ?? TERMINAL_TURN_BUDGET_MS
  let usedBytes = 0
  let usedMs = 0
  return {
    maxBytes,
    maxMs,
    get usedBytes() {
      return usedBytes
    },
    get usedMs() {
      return usedMs
    },
    get exhausted() {
      return usedBytes >= maxBytes || usedMs >= maxMs
    },
    beginTurn() {
      usedBytes = 0
      usedMs = 0
    },
    consume(bytes: number, elapsedMs = 0) {
      usedBytes += bytes
      usedMs += elapsedMs
      return usedBytes < maxBytes && usedMs < maxMs
    },
  }
}

export function writeVtBounded(
  write: (chunk: Uint8Array) => void,
  input: Uint8Array,
  budget: TerminalTurnBudget,
): Uint8Array {
  if (input.byteLength === 0 || budget.exhausted) return input
  const maxTake = Math.max(0, budget.maxBytes - budget.usedBytes)
  if (maxTake <= 0) return input
  let take = Math.min(input.byteLength, maxTake)
  take = utf8SafeEnd(input, take)
  take = ansiSafeEnd(input, take)
  if (take <= 0) take = nextUtf8CharEnd(input, 0)
  const taken = take === input.byteLength ? input : input.subarray(0, take)
  const rest = take === input.byteLength ? new Uint8Array(0) : input.subarray(take)
  const started = performance.now()
  write(taken)
  budget.consume(taken.byteLength, performance.now() - started)
  return rest
}

function nextUtf8CharEnd(bytes: Uint8Array, start: number): number {
  const lead = bytes[start] ?? 0
  const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4
  return Math.min(bytes.length, start + Math.max(1, width))
}

function utf8SafeEnd(bytes: Uint8Array, end: number): number {
  if (end >= bytes.length) return bytes.length
  let cursor = end
  while (cursor > 0 && ((bytes[cursor] ?? 0) & 0xc0) === 0x80) cursor -= 1
  return cursor === 0 && end > 0 && ((bytes[0] ?? 0) & 0xc0) === 0x80 ? end : cursor
}

function ansiSafeEnd(bytes: Uint8Array, end: number): number {
  if (end <= 0 || end >= bytes.length) return end
  let esc = -1
  for (let index = end - 1; index >= 0; index -= 1) {
    const value = bytes[index] ?? 0
    if (value === 0x1b) {
      esc = index
      break
    }
    if (index < end - 16) break
  }
  if (esc < 0) return end
  const next = bytes[esc + 1]
  if (next !== 0x5b && next !== 0x5d && next !== 0x50 && next !== 0x5f && next !== 0x28 && next !== 0x29) {
    return end
  }
  let cursor = esc + 2
  while (cursor < bytes.length) {
    const value = bytes[cursor] ?? 0
    if (next === 0x5d) {
      if (value === 0x07 || (value === 0x5c && bytes[cursor - 1] === 0x1b)) return cursor + 1 <= end ? end : esc
      cursor += 1
      continue
    }
    if (value >= 0x40 && value <= 0x7e) return cursor + 1 <= end ? end : esc
    cursor += 1
  }
  return esc
}

export function createTerminalTurnGate(
  budget: TerminalTurnBudget = createTerminalTurnBudget(),
  schedule: (flush: () => void) => unknown = (flush) => setTimeout(flush, 0),
  cancel: (handle: unknown) => void = (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
) {
  let handle: unknown
  let pending: (() => void) | undefined
  let disposed = false

  const flush = (): void => {
    handle = undefined
    budget.beginTurn()
    const job = pending
    pending = undefined
    if (job) job()
  }

  return {
    budget,
    run(job: () => void): boolean {
      if (disposed) return false
      if (budget.exhausted) {
        pending = job
        handle ??= schedule(flush)
        return false
      }
      const started = performance.now()
      job()
      budget.consume(0, performance.now() - started)
      return true
    },
    dispose() {
      disposed = true
      pending = undefined
      if (handle !== undefined) {
        cancel(handle)
        handle = undefined
      }
    },
  }
}
