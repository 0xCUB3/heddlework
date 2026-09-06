import React from 'react'
import { describe, expect, it } from 'bun:test'
import { connectTest } from '@gpuix/react/automation'
import { createTestRoot, hasNativeTestRenderer } from '@gpuix/react/testing'
import { DemoTransport } from '../src/pi/demo-transport.ts'
import { PiSessionCatalog } from '../src/pi/session-catalog.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { SettingsView } from '../src/ui/settings-view.tsx'
import { ThemeManager } from '../src/ui/theme-manager.ts'
import { RemoteAccessService } from '../src/host/remote-access.ts'
import { TailnetServeService } from '../src/host/tailnet-serve.ts'
import type { TailscaleCli, TailscaleHttpsPort, TailscaleNodeStatus, ServeConfig } from '../src/host/tailscale-cli.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const testNative = hasNativeTestRenderer ? it : it.skip
const DNS = 'macbook-pro-m4.tail8b9c7.ts.net'

function fakeHost(port = 4817) {
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hostname: '127.0.0.1',
    token: 'ui-token',
    workspacePath: '/tmp/heddlework-tailnet-ui',
    connectionCount: () => 0,
    close: async () => undefined,
  }
}

class FakeCli implements TailscaleCli {
  binary: string | undefined = '/opt/homebrew/bin/tailscale'
  nodeStatus: TailscaleNodeStatus = {
    backendState: 'Running',
    httpsCapability: true,
    certDomains: [DNS],
    magicDnsEnabled: true,
    online: true,
    health: [],
    dnsName: DNS,
  }
  config: ServeConfig = {
    tcp: { '443': { https: true } },
    web: { [`${DNS}:443`]: { handlers: { '/': { proxy: 'http://127.0.0.1:30141' } } } },
    allowFunnel: {},
  }
  findBinary = (): string | undefined => this.binary
  status = async (): Promise<TailscaleNodeStatus> => this.nodeStatus
  serveStatus = async (): Promise<ServeConfig> => structuredClone(this.config)
  serveHttps = async (_binary: string, port: TailscaleHttpsPort, target: string): Promise<string> => {
    this.config.tcp[String(port)] = { https: true }
    this.config.web[`${DNS}:${port}`] = { handlers: { '/': { proxy: target } } }
    return `https://${DNS}:${port}/`
  }
  serveHttpsOff = async (_binary: string, port: TailscaleHttpsPort): Promise<void> => {
    delete this.config.tcp[String(port)]
    delete this.config.web[`${DNS}:${port}`]
  }
}

const describeNative = hasNativeTestRenderer ? describe : describe.skip

describeNative('tailnet serve settings', () => {
  testNative('shows Setup when 443 is taken and Stop after a verified 8443 endpoint', async () => {
    const controller = new WorkbenchController(new DemoTransport(), '/tmp/heddlework-tailnet-ui', testControllerDependencies(new PiSessionCatalog({ scope: 'cwd' })))
    await controller.start()
    const remoteAccess = new RemoteAccessService({ initialMode: 'local', preferencePath: false, start: () => fakeHost() })
    const cli = new FakeCli()
    const tailnetServe = new TailnetServeService({
      preferencePath: false,
      getHost: () => remoteAccess.host,
      cli,
      verify: async () => undefined,
    })
    const theme = new ThemeManager({ preferencePath: false, resolveSystemTheme: () => 'dark' })
    await tailnetServe.refresh()
    const root = createTestRoot({ width: 780, height: 1100 })
    root.render(
      <SettingsView
        state={controller.getSnapshot()}
        controller={controller}
        theme={theme.getSnapshot()}
        remoteAccess={remoteAccess}
        tailnetServe={tailnetServe}
        onThemeModeChange={() => undefined}
        onClose={() => undefined}
      />,
    )
    const automation = await connectTest(root.renderer)
    try {
      root.renderer.flush()
      expect(tailnetServe.getSnapshot().status).toBe('idle')
      expect(root.renderer.getPaintedText().join('\n')).toContain('Tailnet HTTPS')
      expect(root.renderer.getPaintedText().join('\n')).toContain('8443')
      expect(await automation.getByTestId('settings-tailnet-setup').count()).toBe(1)
      await automation.getByTestId('settings-tailnet-setup').click()
      await tailnetServe.idle()
      root.render(
        <SettingsView
          state={controller.getSnapshot()}
          controller={controller}
          theme={theme.getSnapshot()}
          remoteAccess={remoteAccess}
          tailnetServe={tailnetServe}
          onThemeModeChange={() => undefined}
          onClose={() => undefined}
        />,
      )
      root.renderer.flush()
      expect(tailnetServe.getSnapshot().status).toBe('ready')
      expect(root.renderer.getPaintedText().join('\n')).toContain(`https://${DNS}:8443`)
      expect(await automation.getByTestId('settings-tailnet-stop').count()).toBe(1)
      expect(await automation.getByTestId('settings-phone-qr').count()).toBe(1)
    } finally {
      await automation.close()
      root.unmount()
      await tailnetServe.dispose()
      await remoteAccess.close()
      theme.dispose()
    }
  }, 20_000)
})
