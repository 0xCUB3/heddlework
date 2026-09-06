import { expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import { createWorkspaceHost } from '../src/host/server.ts'
import { applyWorkbenchCommand, type ServerMessage } from '../src/protocol/index.ts'
import { MemoryTerminalBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'
import { WorkspaceClient } from '../src/web/client.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

it('broadcasts host terminal state to authenticated clients and applies remote writes', async () => {
  const kernel = new WorkbenchKernel()
  kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-terminal-host'))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-terminal-host', demo: true, piArgs: [] }))
  const controller = kernel.get(workbenchControllerToken)
  await controller.start()
  const terminals = new TerminalSessionService({
    cwd: '/tmp/heddlework-terminal-host',
    backend: new MemoryTerminalBackend('ready\r\n'),
    appearancePath: false,
  })
  const host = createWorkspaceHost({
    controller,
    flows: kernel.get(flowRuntimeToken),
    terminals,
    workspacePath: '/tmp/heddlework-terminal-host',
    port: 0,
    token: 'terminal-test-token',
  })
  const kinds: string[] = []
  const client = new WebSocket(`${host.url.replace('http', 'ws')}/ws?token=${host.token}`)
  const web = new WorkspaceClient()
  try {
    await new Promise<void>((resolve, reject) => {
      client.addEventListener('open', () => resolve())
      client.addEventListener('error', () => reject(new Error('socket error')))
    })
    client.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage
      kinds.push(message.kind)
    })
    await waitFor(() => kinds.includes('welcome'), 'welcome')
    web.connect(host.url, host.token)
    await waitFor(() => web.getSnapshot().status === 'open', 'web client open')

    await applyWorkbenchCommand(controller, { type: 'openTerminal', cols: 40, rows: 12 }, { terminals })
    await waitFor(() => terminals.getSnapshot().sessions.length === 1, 'session spawned')
    const id = terminals.getSnapshot().sessions[0]!.id
    await waitFor(() => kinds.includes('terminal'), 'terminal snapshot')
    terminals.write(id, 'printf hi\n')
    await waitFor(() => kinds.includes('terminalFrame'), 'terminal frame')
    await waitFor(() => (terminals.grid(id)?.viewport.some((row) => row.text.includes('printf hi')) ?? false), 'echoed write')

    await applyWorkbenchCommand(controller, { type: 'writeTerminal', id, data: 'next\n' }, { terminals })
    await waitFor(() => terminals.grid(id)?.viewport.some((row) => row.text.includes('next')) === true, 'remote write')

    await applyWorkbenchCommand(controller, { type: 'closeTerminal', id }, { terminals })
    await waitFor(() => terminals.getSnapshot().sessions.length === 0, 'session closed')
  } finally {
    client.close()
    web.disconnect()
    await host.close()
    await terminals.dispose()
    await kernel.dispose()
  }
}, 10_000)
