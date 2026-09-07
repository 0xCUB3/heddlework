import { describe, expect, it } from 'bun:test'
import { createRuntimeControlServer } from '../src/runtime/control-server.ts'
import { createRuntimeSettingsCoordinator } from '../src/runtime/settings-coordinator.ts'
import { RemoteAccessService } from '../src/host/remote-access.ts'
import { TailnetServeService } from '../src/host/tailnet-serve.ts'

it('authenticates lifecycle controls and refuses busy runtime upgrades', async () => {
  const remote = new RemoteAccessService({ initialMode: 'off', preferencePath: false, start: () => { throw new Error('unused') } })
  const tailnet = new TailnetServeService({ preferencePath: false, getHost: () => undefined })
  let busy = true
  let upgrades = 0
  let stops = 0
  const server = createRuntimeControlServer({ token: 'test-token', instanceId: 'instance', protocol: 1, version: 'test', isBusy: () => busy, ...createRuntimeSettingsCoordinator({ workspacePath: '/workspace', remoteAccess: remote, tailnet }), upgrade: async () => { upgrades++ }, stop: async () => { stops++ } })
  const request = (path: string, body?: unknown, authenticated = true) => fetch(`${server.url}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...(authenticated ? { Authorization: 'Bearer test-token' } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  try {
    expect((await request('/status', undefined, false)).status).toBe(401)
    expect((await request('/stop', {}, false)).status).toBe(401)
    expect(stops).toBe(0)
    expect(await (await request('/status')).json()).toMatchObject({ instanceId: 'instance', busy: true, protocol: 1 })
    expect((await request('/upgrade', {})).status).toBe(409)
    expect(upgrades).toBe(0)
    busy = false
    expect((await request('/upgrade', {})).status).toBe(200)
    expect(upgrades).toBe(1)
    expect((await request('/settings/remote', null)).status).toBe(400)
    expect((await request('/settings/tailnet', null)).status).toBe(400)
    expect((await request('/stop', {})).status).toBe(200)
    expect(stops).toBe(1)
  } finally { await server.close(); await tailnet.dispose(); await remote.close() }
})
