import { expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import { createAgentTransportPlugin, createSessionCatalogPlugin, localWorkspaceDiffPlugin, createWorkbenchControllerPlugin, workbenchControllerToken } from '../src/workbench/plugins.ts'
import { createWorkspaceHost } from '../src/host/server.ts'
import { BrowserIntegrationService } from '../src/browser/integrations.ts'
import { WorkspaceClient } from '../src/web/client.ts'

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await Bun.sleep(5) }
  throw new Error('Browser host state did not settle')
}

it('broadcasts browser choices/review/results to authenticated clients and clears them on disconnect', async () => {
  let calls = 0
  const service = new BrowserIntegrationService({ adapters: [{ choice: { id: 'custom', label: 'Custom', available: true, description: 'Test account' }, run: async ({ onOutput }) => { calls++; onOutput('Logged-in fixture result') } }] })
  const kernel = new WorkbenchKernel()
  kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-browser-host'))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60000 }))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-browser-host', demo: true, piArgs: [] }))
  const controller = kernel.get(workbenchControllerToken)
  await controller.start()
  const host = createWorkspaceHost({ controller, flows: kernel.get(flowRuntimeToken), browserIntegrations: service, workspacePath: '/tmp/heddlework-browser-host', port: 0, token: 'browser-test-token' })
  const client = new WorkspaceClient()
  const other = new WorkspaceClient()
  try {
    expect((await fetch(`${host.url}/ws?token=wrong`, { headers: { upgrade: 'websocket', connection: 'upgrade' } })).status).toBe(401)
    client.connect(host.url, host.token); other.connect(host.url, host.token)
    await waitFor(() => client.getSnapshot().status === 'open' && other.getSnapshot().status === 'open')
    expect(client.getSnapshot().browserIntegrations?.selectedId).toBe('builtin')
    await client.send({ type: 'selectBrowserIntegration', integrationId: 'custom', profile: 'work' })
    await client.send({ type: 'requestBrowserTask', prompt: 'Read fixture' })
    await waitFor(() => other.getSnapshot().browserIntegrations?.task?.status === 'review')
    expect(calls).toBe(0)
    const id = other.getSnapshot().browserIntegrations!.task!.id
    await expect(client.send({ type: 'approveBrowserTask', id: 'wrong' })).rejects.toThrow()
    await other.send({ type: 'approveBrowserTask', id })
    await waitFor(() => client.getSnapshot().browserIntegrations?.task?.status === 'completed')
    expect(calls).toBe(1)
    expect(client.getSnapshot().browserIntegrations?.task?.output).toBe('Logged-in fixture result')
    await client.send({ type: 'setEditorText', text: client.getSnapshot().browserIntegrations!.task!.output })
    await waitFor(() => client.getSnapshot().state?.editorText === 'Logged-in fixture result')
    await expect(other.send({ type: 'approveBrowserTask', id })).rejects.toThrow()
    client.disconnect()
    expect(client.getSnapshot().browserIntegrations).toBeUndefined()
    client.connect(host.url, host.token)
    await waitFor(() => client.getSnapshot().status === 'open')
    expect(client.getSnapshot().browserIntegrations?.task?.status).toBe('completed')
    await client.send({ type: 'clearBrowserTask' })
    await waitFor(() => other.getSnapshot().browserIntegrations?.task === null)
  } finally {
    client.disconnect(); other.disconnect(); service.dispose(); await host.close(); await kernel.dispose()
  }
})
