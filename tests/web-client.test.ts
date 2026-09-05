import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import { createWorkspaceHost, type WorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { WorkspaceClient } from '../src/web/client.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

const WORKSPACE = '/tmp/heddlework-web-client'

async function bootstrap(): Promise<{ kernel: WorkbenchKernel; controller: WorkbenchController; host: WorkspaceHost }> {
  const kernel = new WorkbenchKernel()
  kernel.mount(createWorkbenchControllerPlugin(WORKSPACE))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createAgentTransportPlugin({ cwd: WORKSPACE, demo: true, piArgs: [] }))
  const controller = kernel.get(workbenchControllerToken)
  await controller.start()
  const host = createWorkspaceHost({
    controller,
    flows: kernel.get(flowRuntimeToken),
    workspacePath: WORKSPACE,
    port: 0,
    token: generateHostToken(),
  })
  return { kernel, controller, host }
}

function waitFor(client: WorkspaceClient, predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  if (predicate()) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for client snapshot')), timeoutMs)
    const unsubscribe = client.subscribe(() => {
      if (!predicate()) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

describe('web workspace client', () => {
  it('applies welcome and patches, resolves send, and reconnects', async () => {
    const first = await bootstrap()
    const client = new WorkspaceClient()
    client.connect(first.host.url, first.host.token)
    await waitFor(client, () => client.getSnapshot().status === 'open' && client.getSnapshot().state?.connection === 'connected')
    expect(client.getSnapshot().workspacePath).toBe(WORKSPACE)

    await client.send({ type: 'setEditorText', text: 'hi' })
    await waitFor(client, () => client.getSnapshot().state?.editorText === 'hi')

    await first.host.close()
    await waitFor(client, () => client.getSnapshot().status === 'connecting' || client.getSnapshot().status === 'closed')

    const second = await bootstrap()
    client.connect(second.host.url, second.host.token)
    await waitFor(client, () => client.getSnapshot().status === 'open')
    expect(client.getSnapshot().state).toBeDefined()

    client.disconnect()
    await second.host.close()
    await first.kernel.dispose()
    await second.kernel.dispose()
  }, 20_000)

  it('opens a workspace whose welcome exceeds 1 MiB', async () => {
    const { kernel, controller, host } = await bootstrap()
    const payload = 'y'.repeat(1_200_000)
    await controller.setEditorText(payload)
    const client = new WorkspaceClient()
    client.connect(host.url, host.token)
    await waitFor(client, () => client.getSnapshot().state?.editorText === payload, 15_000)
    expect(client.getSnapshot().status).toBe('open')
    expect(client.getSnapshot().lastError).toBeUndefined()
    client.disconnect()
    await host.close()
    await kernel.dispose()
  }, 20_000)
})
