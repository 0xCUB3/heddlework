import { expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import { createWorkspaceHost } from '../src/host/server.ts'
import { createRecordingSleepBackend } from '../src/power/backends.ts'
import { createSleepPreventionPlugin, sleepPreventionToken } from '../src/power/plugin.ts'
import { WorkspaceClient } from '../src/web/client.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

it('broadcasts host sleep policy to authenticated clients and applies remote commands on the host', async () => {
  const backend = createRecordingSleepBackend()
  const kernel = new WorkbenchKernel()
  kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-sleep-host'))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
  kernel.mount(createSleepPreventionPlugin({ preferencePath: false, backend, releaseDebounceMs: 0 }))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-sleep-host', demo: true, piArgs: [] }))
  const controller = kernel.get(workbenchControllerToken)
  await controller.start()
  const sleep = kernel.get(sleepPreventionToken)
  const host = createWorkspaceHost({
    controller,
    flows: kernel.get(flowRuntimeToken),
    sleepPrevention: sleep,
    workspacePath: '/tmp/heddlework-sleep-host',
    port: 0,
    token: 'sleep-test-token',
  })
  const client = new WorkspaceClient()
  const other = new WorkspaceClient()
  try {
    client.connect(host.url, host.token)
    other.connect(host.url, host.token)
    await waitFor(() => client.getSnapshot().status === 'open' && other.getSnapshot().status === 'open', 'clients open')
    expect(client.getSnapshot().sleepPrevention?.policy.when).toBe('whileWorking')
    expect(client.getSnapshot().sleepPrevention?.backend).toBe('none')
    await client.send({ type: 'setSleepPreventionPolicy', when: 'whileAppOpen', keepDisplayAwake: true })
    await waitFor(() => other.getSnapshot().sleepPrevention?.policy.when === 'whileAppOpen', 'peer sees policy')
    expect(other.getSnapshot().sleepPrevention?.policy.keepDisplayAwake).toBe(true)
    await waitFor(() => backend.active === 1, 'host held after remote policy')
    expect(sleep.getSnapshot().inhibiting).toBe(true)
    client.disconnect()
    expect(client.getSnapshot().sleepPrevention).toBeUndefined()
  } finally {
    client.disconnect()
    other.disconnect()
    await host.close()
    await kernel.dispose()
  }
})
