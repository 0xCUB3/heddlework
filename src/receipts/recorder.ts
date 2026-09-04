import type { WorkbenchController } from '../workbench/controller.ts'
import type { WorkspaceDiffService } from '../workbench/services.ts'
import type { WorkspaceDiff, WorkspaceDiffFile } from '../workbench/state.ts'
import type { ReceiptStoreService } from './store.ts'
import { RECEIPT_PATCH_LIMIT_BYTES, type MutationReceipt, type ReceiptFile, type ReceiptToolCount } from './types.ts'

export interface ReceiptRecorderOptions {
  controller: WorkbenchController
  workspaceDiff: WorkspaceDiffService
  store: ReceiptStoreService
  now?: (() => number) | undefined
  createId?: (() => string) | undefined
}

// Watches turn boundaries on the controller and records what the working tree gained during each turn.
export function createReceiptRecorder(options: ReceiptRecorderOptions): () => void {
  const now = options.now ?? (() => Date.now())
  const createId = options.createId ?? (() => `RCPT-${globalThis.crypto.randomUUID().slice(0, 8)}`)
  let wasStreaming = options.controller.getSnapshot().session.isStreaming
  let sessionKey = sessionIdentity(options.controller)
  let baseline: Promise<WorkspaceDiff> | undefined
  let startedAt = 0
  let messageCount = 0
  let turn = 0
  let generation = 0

  const publish = (): void => {
    options.controller.setReceipts(options.store.list(sessionIdentity(options.controller)))
  }
  publish()

  const unsubscribeClear = options.controller.onClearReceipts((sessionPath) => {
    options.store.clear(sessionPath)
    publish()
  })
  const unsubscribe = options.controller.subscribe(() => {
    const state = options.controller.getSnapshot()
    const key = sessionIdentity(options.controller)
    if (key !== sessionKey) {
      sessionKey = key
      turn = 0
      baseline = undefined
      publish()
    }
    const streaming = state.session.isStreaming
    if (streaming === wasStreaming) return
    wasStreaming = streaming
    if (streaming) {
      startedAt = now()
      messageCount = state.messages.length
      generation += 1
      baseline = options.workspaceDiff.load(state.workspacePath)
      return
    }
    const before = baseline
    baseline = undefined
    if (!before) return
    const thisGeneration = generation
    const turnNumber = ++turn
    const messagesAfter = state.messages.slice(messageCount)
    void (async () => {
      const [previous, next] = await Promise.all([before, options.workspaceDiff.load(state.workspacePath)])
      if (thisGeneration !== generation || sessionIdentity(options.controller) !== key) return
      const files = diffReceiptFiles(previous, next)
      if (files.length === 0) return
      const receipt: MutationReceipt = {
        id: createId(),
        sessionPath: key,
        turn: turnNumber,
        startedAt,
        completedAt: now(),
        files,
        tools: countTools(messagesAfter),
      }
      options.store.append(receipt)
      publish()
    })()
  })
  return () => {
    unsubscribe()
    unsubscribeClear()
  }
}

export function sessionIdentity(controller: Pick<WorkbenchController, 'getSnapshot'>): string {
  const state = controller.getSnapshot()
  return state.session.sessionFile ?? `${state.workspacePath}#unsaved`
}

export function diffReceiptFiles(previous: WorkspaceDiff, next: WorkspaceDiff): ReceiptFile[] {
  if (next.status === 'error' || previous.status === 'error') return []
  const before = new Map(previous.files.map((file) => [file.path, file]))
  const after = new Map(next.files.map((file) => [file.path, file]))
  const files: ReceiptFile[] = []
  for (const [path, file] of after) {
    const earlier = before.get(path)
    if (!earlier) {
      files.push(toReceiptFile(file, isNewFilePatch(file.patch) ? 'added' : 'modified'))
      continue
    }
    if (earlier.patch !== file.patch) files.push(toReceiptFile(file, isDeletedFilePatch(file.patch) ? 'deleted' : 'modified'))
  }
  for (const [path, file] of before) {
    if (after.has(path)) continue
    // A file that left the diff was either reverted or committed; record it as touched with the last known counts.
    files.push({ path, status: isNewFilePatch(file.patch) ? 'deleted' : 'modified', additions: 0, deletions: 0 })
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function toReceiptFile(file: WorkspaceDiffFile, status: ReceiptFile['status']): ReceiptFile {
  const bytes = new TextEncoder().encode(file.patch).length
  return {
    path: file.path,
    status,
    additions: file.additions,
    deletions: file.deletions,
    ...(bytes > RECEIPT_PATCH_LIMIT_BYTES ? { patch: undefined, truncated: true } : { patch: file.patch }),
  }
}

function isNewFilePatch(patch: string): boolean {
  return /^--- (\/dev\/null|NUL)\r?$/m.test(patch) || /^new file mode/m.test(patch)
}

function isDeletedFilePatch(patch: string): boolean {
  return /^\+\+\+ (\/dev\/null|NUL)\r?$/m.test(patch) || /^deleted file mode/m.test(patch)
}

export function countTools(messages: readonly unknown[]): ReceiptToolCount[] {
  const counts = new Map<string, number>()
  for (const message of messages) {
    const record = message as { role?: string; content?: unknown; toolName?: string }
    if (record.role === 'toolResult' && typeof record.toolName === 'string') {
      counts.set(record.toolName, (counts.get(record.toolName) ?? 0) + 1)
      continue
    }
    if (record.role !== 'assistant' || !Array.isArray(record.content)) continue
    for (const block of record.content as Array<{ type?: string; name?: string }>) {
      if (block.type === 'toolCall' && typeof block.name === 'string') counts.set(block.name, (counts.get(block.name) ?? 0) + 1)
    }
  }
  return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
}
