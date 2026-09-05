import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin } from '../src/flows/plugin.ts'
import { createWorkspaceHostPlugin, hostOptionsFromEnvironment, workspaceHostToken } from '../src/host/plugin.ts'
import { loadOrCreateHostToken, timingSafeEqualToken } from '../src/host/token.ts'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
} from '../src/workbench/plugins.ts'

function mountCore(kernel: WorkbenchKernel, workspace: string): void {
  kernel.mount(createWorkbenchControllerPlugin(workspace))
  kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
  kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
  kernel.mount(localWorkspaceDiffPlugin)
  kernel.mount(createAgentTransportPlugin({ cwd: workspace, demo: true, piArgs: [] }))
}

describe('workspace host plugin', () => {
  it('provides undefined when disabled', async () => {
    const kernel = new WorkbenchKernel()
    mountCore(kernel, '/tmp/heddlework-host-plugin-off')
    kernel.mount(createWorkspaceHostPlugin({ enabled: false, workspacePath: '/tmp/heddlework-host-plugin-off' }))
    expect(kernel.get(workspaceHostToken)).toBeUndefined()
    await kernel.dispose()
  })

  it('starts a host and closes it with the kernel', async () => {
    const kernel = new WorkbenchKernel()
    mountCore(kernel, '/tmp/heddlework-host-plugin-on')
    kernel.mount(createWorkspaceHostPlugin({ enabled: true, workspacePath: '/tmp/heddlework-host-plugin-on', port: 0, tokenPath: false }))
    const host = kernel.get(workspaceHostToken)
    expect(host).toBeDefined()
    expect((await fetch(`${host!.url}/health`)).status).toBe(200)
    await kernel.dispose()
    await expect(fetch(`${host!.url}/health`)).rejects.toThrow()
  }, 10_000)

  it('persists a token with owner-only permissions and compares in constant time', () => {
    const dir = mkdtempSync(join(tmpdir(), 'heddlework-token-'))
    const path = join(dir, 'nested', 'host-token')
    const first = loadOrCreateHostToken(path)
    const second = loadOrCreateHostToken(path)
    expect(second).toBe(first)
    expect(readFileSync(path, 'utf8').trim()).toBe(first)
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(timingSafeEqualToken(first, first)).toBe(true)
    expect(timingSafeEqualToken(first, `${first}x`)).toBe(false)
    expect(timingSafeEqualToken(first, undefined)).toBe(false)
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads host options from the environment with safe defaults', () => {
    expect(hostOptionsFromEnvironment({})).toEqual({ enabled: false, port: 4817, hostname: '127.0.0.1' })
    expect(hostOptionsFromEnvironment({ HEDDLEWORK_HOST: '1', HEDDLEWORK_HOST_PORT: '5000', HEDDLEWORK_HOST_BIND: '0.0.0.0' })).toEqual({ enabled: true, port: 5000, hostname: '0.0.0.0', lockedBy: 'HEDDLEWORK_HOST' })
    expect(hostOptionsFromEnvironment({ HEDDLEWORK_HOST_PORT: 'junk' }).port).toBe(4817)
  })

  it('falls back to the saved remote access mode when the environment says nothing', async () => {
    const { mkdtempSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { readRemoteAccessMode, writeRemoteAccessMode, RemoteAccessService } = await import('../src/host/remote-access.ts')
    const path = join(mkdtempSync(join(tmpdir(), 'hw-remote-')), 'preferences.json')
    writeFileSync(path, JSON.stringify({ theme: 'dark' }))
    expect(hostOptionsFromEnvironment({}, path)).toEqual({ enabled: false, port: 4817, hostname: '127.0.0.1' })
    writeRemoteAccessMode('network', path)
    expect(readRemoteAccessMode(path)).toBe('network')
    expect(JSON.parse(readFileSync(path, 'utf8')).theme).toBe('dark')
    expect(hostOptionsFromEnvironment({}, path)).toEqual({ enabled: true, port: 4817, hostname: '0.0.0.0' })
    // The environment still wins over the saved mode.
    expect(hostOptionsFromEnvironment({ HEDDLEWORK_HOST: '0' }, path).enabled).toBe(false)

    // Switching modes closes the old host, starts the new one, and persists the choice.
    const log: string[] = []
    const fake = (name: string) => ({ url: name, port: 1, hostname: name, token: 't', workspacePath: '/w', connectionCount: () => 0, close: async () => { log.push(`close ${name}`) } })
    const service = new RemoteAccessService({ initialMode: 'off', preferencePath: path, start: (mode) => { log.push(`start ${mode}`); return fake(mode) } })
    expect(service.getSnapshot().host).toBeUndefined()
    await service.setMode('local')
    await service.setMode('network')
    await service.setMode('off')
    expect(log).toEqual(['start local', 'close local', 'start network', 'close network'])
    expect(readRemoteAccessMode(path)).toBe('off')
  })
})
