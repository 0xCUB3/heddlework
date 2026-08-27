import { describe, expect, it } from 'bun:test'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

function waitForSettled(controller: WorkbenchController): Promise<void> {
  if (isFullySettled(controller)) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => {
      if (!isFullySettled(controller)) return
      unsubscribe()
      resolve()
    })
  })
}

function isFullySettled(controller: WorkbenchController): boolean {
  const state = controller.getSnapshot()
  return !state.session.isStreaming && state.liveAssistant === undefined && state.liveTools.length === 0
}

describe('WorkbenchController', () => {
  it('boots, streams a task, and rehydrates the authoritative transcript', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/example-workspace', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    try {
      await controller.start()
      expect(controller.getSnapshot().connection).toBe('connected')
      expect(controller.getSnapshot().models).toHaveLength(2)

      controller.setEditorText('Inspect the repository')
      await controller.submit(controller.getSnapshot().editorText)
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      await waitForSettled(controller)

      const state = controller.getSnapshot()
      expect(state.session.isStreaming).toBe(false)
      expect(state.messages.some((message) => message.role === 'toolResult')).toBe(true)
      expect(state.messages.at(-1)?.role).toBe('assistant')
      expect(state.liveTools).toEqual([])
      expect(state.forkMessages).toHaveLength(1)
      await controller.forkFrom(state.forkMessages[0]!.entryId)
      expect(controller.getSnapshot().editorText).toBe('Inspect the repository')
      expect(controller.getSnapshot().messages).toHaveLength(0)
    } finally {
      await controller.dispose()
    }
  }, 4_000)
})
