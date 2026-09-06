import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin } from '../src/flows/plugin.ts'
import { applyWorkbenchCommand, isWorkbenchCommand, WORKBENCH_COMMAND_TYPES } from '../src/protocol/index.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'
import {
  agentTransportToken,
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'
import { isHarnessAdapter } from '../src/protocol/adapter.ts'

async function bootstrap(): Promise<{ kernel: WorkbenchKernel; controller: WorkbenchController }> {
  const kernel = new WorkbenchKernel()
  kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-protocol-commands'))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-protocol-commands', demo: true, piArgs: [] }))
  const controller = kernel.get(workbenchControllerToken)
  await controller.start()
  return { kernel, controller }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('workbench command protocol', () => {
  it('exposes the demo and rpc transports as harness adapters', async () => {
    const { kernel } = await bootstrap()
    const transport = kernel.get(agentTransportToken)
    expect(isHarnessAdapter(transport)).toBe(true)
    expect(isHarnessAdapter({})).toBe(false)
    await kernel.dispose()
  })

  it('recognises every declared command type and rejects unknown ones', () => {
    for (const type of WORKBENCH_COMMAND_TYPES) expect(isWorkbenchCommand({ type, integrationId: 'aside', profile: 'u0', prompt: 'Read example.com', id: 'review-id', when: 'whileWorking', keepDisplayAwake: false })).toBe(true)
    expect(isWorkbenchCommand({ type: 'explode' })).toBe(false)
    expect(isWorkbenchCommand(null)).toBe(false)
  })

  it('drives the controller through plain data commands', async () => {
    const { kernel, controller } = await bootstrap()
    expect(controller.getSnapshot().connection).toBe('connected')

    await applyWorkbenchCommand(controller, { type: 'setEditorText', text: 'hello from the wire' })
    expect(controller.getSnapshot().editorText).toBe('hello from the wire')

    await applyWorkbenchCommand(controller, { type: 'setThinkingLevel', level: 'high' })
    expect(controller.getSnapshot().session.thinkingLevel).toBe('high')

    await applyWorkbenchCommand(controller, { type: 'submit', text: 'Run a turn over the protocol' })
    await waitFor(() => controller.getSnapshot().session.isStreaming, 'streaming to begin')
    await applyWorkbenchCommand(controller, { type: 'queueInput', text: 'steer me', lane: 'steer' })
    const queued = controller.getSnapshot().queue.items
    expect(queued.some((item) => item.text === 'steer me')).toBe(true)
    const queuedId = queued.find((item) => item.text === 'steer me')!.id
    await applyWorkbenchCommand(controller, { type: 'updateQueuedInput', id: queuedId, text: 'steer me harder' })
    expect(controller.getSnapshot().queue.items.find((item) => item.id === queuedId)?.text).toBe('steer me harder')
    await applyWorkbenchCommand(controller, { type: 'removeQueuedInput', id: queuedId })
    expect(controller.getSnapshot().queue.items.some((item) => item.id === queuedId)).toBe(false)

    await applyWorkbenchCommand(controller, { type: 'abort' })
    await waitFor(() => !controller.getSnapshot().session.isStreaming, 'abort to settle')

    const sessionPath = controller.getSnapshot().session.sessionFile ?? '/tmp/heddlework-protocol-commands/session'
    await applyWorkbenchCommand(controller, { type: 'settleThread', path: sessionPath })
    expect(controller.getSnapshot().threadLifecycle[sessionPath]?.settledAt).toBeNumber()
    await applyWorkbenchCommand(controller, { type: 'wakeThread', path: sessionPath })
    expect(controller.getSnapshot().threadLifecycle[sessionPath]?.settledAt).toBeUndefined()

    await expect(applyWorkbenchCommand(controller, { type: 'setModel', provider: 'nope', id: 'missing' })).rejects.toThrow('Unknown model')
    await expect(applyWorkbenchCommand(controller, { type: 'switchSession', path: '/does/not/exist' })).rejects.toThrow('Unknown session')

    const model = controller.getSnapshot().models[0]
    if (model) {
      await applyWorkbenchCommand(controller, { type: 'setModel', provider: model.provider, id: model.id })
      expect(controller.getSnapshot().session.model?.id).toBe(model.id)
    }

    await kernel.dispose()
  }, 10_000)
})
