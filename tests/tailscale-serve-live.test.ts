import { describe, expect, it } from 'bun:test'
import { createTailscaleCli, findTailscaleBinary, handlerAt, type ServeConfig } from '../src/host/tailscale-cli.ts'
import { createWorkspaceHost } from '../src/host/server.ts'
import { generateHostToken } from '../src/host/token.ts'
import { TailnetServeService } from '../src/host/tailnet-serve.ts'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin, flowRuntimeToken } from '../src/flows/plugin.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'
import { FrameAssembler, parseServerMessage, type ServerMessage } from '../src/protocol/index.ts'

const LIVE_PORT: 8443 = 8443
const WORKSPACE = '/tmp/heddlework-tailnet-live'

function snapshot443(config: ServeConfig): unknown {
  return {
    tcp: config.tcp['443'] ?? null,
    web: config.web[Object.keys(config.web).find((key) => key.endsWith(':443')) ?? ''] ?? null,
  }
}

async function waitForWelcome(url: string, token: string): Promise<ServerMessage> {
  const socketUrl = `${url.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:')}/ws?token=${encodeURIComponent(token)}`
  const frames = new FrameAssembler()
  const socket = new WebSocket(socketUrl)
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.close()
      reject(new Error('Timed out waiting for welcome over tailnet HTTPS'))
    }, 12_000)
    socket.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error('WebSocket error over tailnet HTTPS'))
    })
    socket.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return
      const assembled = frames.push(event.data)
      if (!assembled) return
      const message = parseServerMessage(assembled)
      if (message?.kind !== 'welcome') return
      clearTimeout(timer)
      socket.send(JSON.stringify({ kind: 'ping' }))
      socket.close()
      resolve(message)
    })
  })
}

describe('tailscale serve live', () => {
  it('proxies a loopback workbench on a free 8443 endpoint and leaves 443 alone', async () => {
    const binary = findTailscaleBinary()
    if (!binary) return
    const cli = createTailscaleCli()
    let status
    try {
      status = await cli.status(binary)
    } catch {
      return
    }
    if (status.backendState !== 'Running' || !status.httpsCapability || !status.dnsName) return
    const before = await cli.serveStatus(binary)
    if (handlerAt(before, status.dnsName, LIVE_PORT) || before.tcp[String(LIVE_PORT)]) return

    const kernel = new WorkbenchKernel()
    kernel.mount(createWorkbenchControllerPlugin(WORKSPACE))
    kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
    kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
    kernel.mount(localWorkspaceDiffPlugin)
    kernel.mount(createAgentTransportPlugin({ cwd: WORKSPACE, demo: true, piArgs: [] }))
    let tailnet: TailnetServeService | undefined
    const host = createWorkspaceHost({
      controller: kernel.get(workbenchControllerToken),
      flows: kernel.get(flowRuntimeToken),
      workspacePath: WORKSPACE,
      port: 0,
      hostname: '127.0.0.1',
      token: generateHostToken(),
      extraHostUrls: () => tailnet?.advertisedHostUrls() ?? [],
    })
    tailnet = new TailnetServeService({
      preferencePath: false,
      getHost: () => host,
      cli,
    })
    try {
      await tailnet.setHttpsPort(LIVE_PORT)
      await tailnet.setEnabled(true)
      const snapshot = tailnet.getSnapshot()
      if (snapshot.status !== 'ready') {
        expect(['needsHttps', 'error']).toContain(snapshot.status)
        return
      }
      expect(snapshot.url).toBe(`https://${status.dnsName}:8443`)
      expect(snapshot.url).not.toContain('token=')
      const url = snapshot.url
      if (!url) throw new Error('ready snapshot missing url')
      const health = await fetch(`${url}/health`)
      expect(health.ok).toBe(true)
      const denied = await fetch(`${url}/ws`)
      expect([401, 426]).toContain(denied.status)
      const welcome = await waitForWelcome(url, host.token)
      expect(welcome.kind).toBe('welcome')
      if (welcome.kind === 'welcome') {
        expect(welcome.hostUrls?.[0]).toBe(url)
        expect(welcome.workspacePath).toBe(WORKSPACE)
      }
      const mid = await cli.serveStatus(binary)
      expect(snapshot443(mid)).toEqual(snapshot443(before))
      expect(handlerAt(mid, status.dnsName, LIVE_PORT)?.proxy).toBe(`http://127.0.0.1:${host.port}`)
    } finally {
      await tailnet.setEnabled(false).catch(() => undefined)
      await tailnet.dispose()
      await host.close()
      await kernel.dispose()
      const after = await cli.serveStatus(binary)
      expect(snapshot443(after)).toEqual(snapshot443(before))
      expect(handlerAt(after, status.dnsName, LIVE_PORT)).toBeUndefined()
    }
  }, 40_000)
})
