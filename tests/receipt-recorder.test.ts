import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel, type WorkbenchPlugin } from '../src/core/kernel.ts'
import { createReceiptPlugin, receiptStoreToken } from '../src/receipts/plugin.ts'
import { countTools, diffReceiptFiles } from '../src/receipts/recorder.ts'
import { FileReceiptStore } from '../src/receipts/store.ts'
import type { WorkspaceDiffService } from '../src/workbench/services.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'
import type { WorkspaceDiff } from '../src/workbench/state.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  workbenchControllerToken,
  workspaceDiffToken,
} from '../src/workbench/plugins.ts'

const WORKSPACE = '/tmp/heddlework-receipts'

const addedPatch = 'diff --git a/notes.md b/notes.md\nnew file mode 100644\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1 @@\n+hello\n'
const modifiedBefore = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n'
const modifiedAfter = 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n-old\n+new\n-x\n+y\n'

function ready(files: WorkspaceDiff['files']): WorkspaceDiff {
  return { status: 'ready', branch: 'main', files, additions: 0, deletions: 0 }
}

// The controller also loads the diff on connect and after each turn, so the fake keys on the turn phase, not the call count.
function scriptedDiffPlugin(results: WorkspaceDiff[], getController: () => WorkbenchController | undefined): WorkbenchPlugin {
  return {
    id: 'scripted-diff',
    activate(ctx) {
      let seenStreaming = false
      const service: WorkspaceDiffService = {
        async load() {
          const streaming = getController()?.getSnapshot().session.isStreaming ?? false
          if (streaming) seenStreaming = true
          const before = results[0]!
          const after = results[results.length - 1]!
          return seenStreaming && !streaming ? after : before
        },
      }
      ctx.provide(workspaceDiffToken, service)
    },
  }
}

async function runTurn(results: WorkspaceDiff[]) {
  const kernel = new WorkbenchKernel()
  const store = new FileReceiptStore(false)
  kernel.mount(createWorkbenchControllerPlugin(WORKSPACE))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  let controllerRef: WorkbenchController | undefined
  kernel.mount(scriptedDiffPlugin(results, () => controllerRef))
  kernel.mount(createAgentTransportPlugin({ cwd: WORKSPACE, demo: true, piArgs: [] }))
  kernel.mount(createReceiptPlugin({ path: false, store }))
  const controller = kernel.get(workbenchControllerToken)
  controllerRef = controller
  expect(kernel.get(receiptStoreToken)).toBe(store)
  await controller.start()
  await controller.submit('Change something')
  await new Promise<void>((resolve) => {
    const stop = controller.subscribe(() => {
      const state = controller.getSnapshot()
      if (!state.session.isStreaming && state.messages.at(-1)?.role === 'assistant') { stop(); resolve() }
    })
  })
  await new Promise((resolve) => setTimeout(resolve, 30))
  return { kernel, controller, store }
}

describe('receipt recorder', () => {
  it('records one receipt with file statuses and tool counts after a turn that changed files', async () => {
    const { kernel, controller } = await runTurn([
      ready([{ path: 'src/a.ts', patch: modifiedBefore, additions: 1, deletions: 1 }]),
      ready([
        { path: 'src/a.ts', patch: modifiedAfter, additions: 2, deletions: 2 },
        { path: 'notes.md', patch: addedPatch, additions: 1, deletions: 0 },
      ]),
    ])
    const receipts = controller.getSnapshot().receipts
    expect(receipts).toHaveLength(1)
    const receipt = receipts[0]!
    expect(receipt.turn).toBe(1)
    expect(receipt.files.map((file) => [file.path, file.status])).toEqual([['notes.md', 'added'], ['src/a.ts', 'modified']])
    expect(receipt.files[0]!.patch).toBe(addedPatch)
    expect(receipt.tools).toEqual([{ name: 'bash', count: 2 }])
    expect(receipt.completedAt).toBeGreaterThanOrEqual(receipt.startedAt)

    controller.clearReceipts(receipt.sessionPath)
    expect(controller.getSnapshot().receipts).toEqual([])
    await kernel.dispose()
  }, 10_000)

  it('appends nothing when the tree did not change', async () => {
    const { kernel, controller, store } = await runTurn([ready([{ path: 'src/a.ts', patch: modifiedBefore, additions: 1, deletions: 1 }])])
    expect(controller.getSnapshot().receipts).toEqual([])
    expect(store.list('anything')).toEqual([])
    await kernel.dispose()
  }, 10_000)

  it('classifies files and truncates oversized patches', () => {
    const huge = `${modifiedBefore}${'+x\n'.repeat(120_000)}`
    const files = diffReceiptFiles(
      ready([{ path: 'gone.ts', patch: addedPatch.replaceAll('notes.md', 'gone.ts'), additions: 1, deletions: 0 }, { path: 'big.ts', patch: modifiedBefore, additions: 1, deletions: 1 }]),
      ready([{ path: 'big.ts', patch: huge, additions: 1, deletions: 1 }]),
    )
    expect(files.map((file) => [file.path, file.status, file.truncated ?? false])).toEqual([['big.ts', 'modified', true], ['gone.ts', 'deleted', false]])
    expect(files[0]!.patch).toBeUndefined()
    expect(diffReceiptFiles({ status: 'error', branch: '', files: [], additions: 0, deletions: 0 }, ready([]))).toEqual([])
  })

  it('counts tool calls from assistant blocks without double counting results', () => {
    const messages = [
      { role: 'assistant', content: [{ type: 'toolCall', name: 'edit' }, { type: 'toolCall', name: 'bash' }] },
      { role: 'toolResult', toolName: 'edit' },
      { role: 'toolResult', toolName: 'bash' },
      { role: 'assistant', content: [{ type: 'toolCall', name: 'edit' }] },
      { role: 'toolResult', toolName: 'edit' },
    ]
    expect(countTools(messages)).toEqual([{ name: 'edit', count: 4 }, { name: 'bash', count: 2 }])
  })
})
