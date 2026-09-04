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
    expect(hostOptionsFromEnvironment({ HEDDLEWORK_HOST: '1', HEDDLEWORK_HOST_PORT: '5000', HEDDLEWORK_HOST_BIND: '0.0.0.0' })).toEqual({ enabled: true, port: 5000, hostname: '0.0.0.0' })
    expect(hostOptionsFromEnvironment({ HEDDLEWORK_HOST_PORT: 'junk' }).port).toBe(4817)
  })
})
