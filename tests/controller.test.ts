import { describe, expect, it } from 'bun:test'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'

describe('WorkbenchController', () => {
  it('boots, streams a task, and rehydrates the authoritative transcript', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/example-workspace')
    try {
      await controller.start()
      expect(controller.getSnapshot().connection).toBe('connected')
      expect(controller.getSnapshot().models).toHaveLength(2)

      controller.setEditorText('Inspect the repository')
      await controller.submit(controller.getSnapshot().editorText)
      expect(controller.getSnapshot().session.isStreaming).toBe(true)
      await Bun.sleep(1_650)

      const state = controller.getSnapshot()
      expect(state.session.isStreaming).toBe(false)
      expect(state.messages.some((message) => message.role === 'toolResult')).toBe(true)
      expect(state.messages.at(-1)?.role).toBe('assistant')
      expect(state.liveTools).toEqual([])
    } finally {
      await controller.dispose()
    }
  }, 4_000)
})
