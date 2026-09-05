import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import { createWorkspaceHost, hostConnectUrl } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { createAgentTransportPlugin, createSessionCatalogPlugin, createWorkbenchControllerPlugin, localWorkspaceDiffPlugin, workbenchControllerToken } from '../src/workbench/plugins.ts'

// A loopback-only demo host for checking all renderers without touching real sessions.
const workspacePath = '/tmp/heddlework-ui-parity'
mkdirSync(workspacePath, { recursive: true })
const kernel = new WorkbenchKernel()
kernel.mount(createWorkbenchControllerPlugin(workspacePath))
kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
kernel.mount(localWorkspaceDiffPlugin)
kernel.mount(createAgentTransportPlugin({ cwd: workspacePath, demo: true, piArgs: [] }))
const controller = kernel.get(workbenchControllerToken)
await controller.start()
const host = createWorkspaceHost({
  controller,
  flows: kernel.get(flowRuntimeToken),
  workspacePath,
  port: Number(process.env.HEDDLEWORK_PARITY_PORT ?? 4818),
  hostname: '127.0.0.1',
  token: generateHostToken(),
  staticRoot: resolve(import.meta.dir, '../dist/web'),
})
console.log(hostConnectUrl(host))
const shutdown = async () => { await host.close(); await kernel.dispose(); process.exit(0) }
process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())
await controller.submit('Show the shared workbench interface and explain the current changes.')
