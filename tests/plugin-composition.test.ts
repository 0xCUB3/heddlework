import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import {
  agentTransportToken,
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

describe('workbench plugin composition', () => {
  it('activates an early consumer only after every capability arrives and streams over kernel events', async () => {
    const kernel = new WorkbenchKernel()
    kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-plugin-composition'))
    expect(() => kernel.get(workbenchControllerToken)).toThrow('Missing service: workbench-controller')

    kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
    kernel.mount(localWorkspaceDiffPlugin)
    expect(() => kernel.get(workbenchControllerToken)).toThrow('Missing service: workbench-controller')

    kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-plugin-composition', demo: true, piArgs: [] }))
    const controller = kernel.get(workbenchControllerToken)
    await controller.start()
    expect(controller.getSnapshot().connection).toBe('connected')

    controller.setEditorText('Exercise the plugin event bridge')
    await controller.submit(controller.getSnapshot().editorText)
    await waitFor(() => !controller.getSnapshot().session.isStreaming)
    expect(controller.getSnapshot().messages.at(-1)?.role).toBe('assistant')

    await kernel.dispose()
    expect(() => kernel.get(workbenchControllerToken)).toThrow('Missing service: workbench-controller')
    expect(() => kernel.get(agentTransportToken)).toThrow('Missing service: agent-transport')
  }, 5_000)
})

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Plugin-composed controller did not settle')
}
