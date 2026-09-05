import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import { createWorkspaceHost, type WorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { applySnapshotPatch, type WorkbenchSnapshot } from '../src/protocol/index.ts'
import { WorkspaceClient } from '../src/web/client.ts'
import type { WorkbenchController } from '../src/workbench/controller.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

const WORKSPACE = '/tmp/heddlework-web-multiple-turn'
const DEMO_REPLY = 'The workbench transport, event reducer, and native GPUIX transcript are connected.'

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

function waitFor(client: WorkspaceClient, predicate: () => boolean, timeoutMs = 6_000): Promise<void> {
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

describe('web multiple-turn transcript', () => {
  it('settles consecutive demo turns without leaving stale live tools in the client', async () => {
    const { kernel, host } = await bootstrap()
    const client = new WorkspaceClient()
    try {
      client.connect(host.url, host.token)
      await waitFor(client, () => client.getSnapshot().status === 'open' && client.getSnapshot().state?.connection === 'connected')

      await client.send({ type: 'submit', text: 'first web turn' })
      await waitFor(client, () => client.getSnapshot().state?.activity === 'Ready' && client.getSnapshot().state?.session.isStreaming === false && settledDemoReplies(client.getSnapshot().state!) === 1)
      expect(settledDemoReplies(client.getSnapshot().state!)).toBe(1)
      expect(client.getSnapshot().state?.liveTools).toHaveLength(0)
      expect(client.getSnapshot().state?.liveAssistant).toBeUndefined()

      await client.send({ type: 'submit', text: 'second web turn' })
      await waitFor(client, () => client.getSnapshot().state?.activity === 'Ready' && client.getSnapshot().state?.session.isStreaming === false && settledDemoReplies(client.getSnapshot().state!) === 2)
      const state = client.getSnapshot().state!
      expect(state.liveTools).toHaveLength(0)
      expect(state.liveAssistant).toBeUndefined()
      expect(state.activity).toBe('Ready')
      expect(settledDemoReplies(state)).toBe(2)
    } finally {
      client.disconnect()
      await host.close()
      await kernel.dispose()
    }
  }, 20_000)

  it('applies removed snapshot keys so stale live rows disappear after patches', () => {
    const current = {
      liveAssistant: { id: 'live', blocks: [] },
      liveTools: [{ id: 'tool', name: 'bash', args: {}, status: 'preparing' }],
    } as unknown as WorkbenchSnapshot
    const next = applySnapshotPatch(current, { version: 1, changed: { liveTools: [] }, removed: ['liveAssistant'] })
    expect(next.liveAssistant).toBeUndefined()
    expect(next.liveTools).toEqual([])
  })
})

function settledDemoReplies(state: WorkbenchSnapshot): number {
  return state.messages.filter((message) => message.role === 'assistant' && JSON.stringify(message.content).includes(DEMO_REPLY)).length
}
