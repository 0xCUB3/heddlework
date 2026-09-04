import { describe, expect, it } from 'bun:test'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { checkForUpdate, compareSemver, parseSemver } from '../src/updates/check.ts'
import { createUpdateCheckPlugin } from '../src/updates/plugin.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

function fakeFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
}

describe('update check', () => {
  it('reports a newer tag and ignores older or equal ones', async () => {
    const newer = await checkForUpdate({ currentVersion: '0.1.0', fetch: fakeFetch({ tag_name: 'v0.2.0', html_url: 'https://example.test/r/v0.2.0' }) })
    expect(newer).toEqual({ available: true, version: '0.2.0', url: 'https://example.test/r/v0.2.0' })
    const older = await checkForUpdate({ currentVersion: '0.3.0', fetch: fakeFetch({ tag_name: 'v0.2.9' }) })
    expect(older.available).toBe(false)
    const same = await checkForUpdate({ currentVersion: 'v0.2.0', fetch: fakeFetch({ tag_name: 'v0.2.0' }) })
    expect(same.available).toBe(false)
    const pre = await checkForUpdate({ currentVersion: '0.2.0-rc.1', fetch: fakeFetch({ tag_name: 'v0.2.0' }) })
    expect(pre.available).toBe(true)
  })

  it('returns available false on network failure, bad status, or junk without throwing', async () => {
    const failing = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    expect(await checkForUpdate({ currentVersion: '0.1.0', fetch: failing })).toEqual({ available: false, error: 'offline' })
    expect((await checkForUpdate({ currentVersion: '0.1.0', fetch: fakeFetch({}, 500) })).available).toBe(false)
    expect((await checkForUpdate({ currentVersion: '0.1.0', fetch: fakeFetch({ tag_name: 'nightly' }) })).available).toBe(false)
    expect((await checkForUpdate({ currentVersion: '0.1.0', fetch: fakeFetch({ tag_name: 'v9.0.0', draft: true }) })).available).toBe(false)
  })

  it('orders semver with prerelease identifiers', () => {
    const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.1.0', '2.0.0']
    for (let index = 1; index < order.length; index += 1) {
      expect(compareSemver(parseSemver(order[index]!)!, parseSemver(order[index - 1]!)!)).toBeGreaterThan(0)
    }
    expect(parseSemver('v1.2.3+build.5')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseSemver('1.2')).toBeUndefined()
  })

  it('posts one notice through the controller when an update exists and cancels on dispose', async () => {
    const kernel = new WorkbenchKernel()
    kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-update'))
    kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
    kernel.mount(localWorkspaceDiffPlugin)
    kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-update', demo: true, piArgs: [] }))
    kernel.mount(createUpdateCheckPlugin({ enabled: true, delayMs: 5, currentVersion: '0.1.0', fetch: fakeFetch({ tag_name: 'v0.9.0', html_url: 'https://example.test/latest' }) }))
    const controller = kernel.get(workbenchControllerToken)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const notices = controller.getSnapshot().notices.map((notice) => notice.message)
    expect(notices).toEqual([expect.stringContaining('Heddlework 0.9.0 is available')])
    expect(notices[0]).toContain('https://example.test/latest')

    const silent = new WorkbenchKernel()
    silent.mount(createWorkbenchControllerPlugin('/tmp/heddlework-update-2'))
    silent.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
    silent.mount(localWorkspaceDiffPlugin)
    silent.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-update-2', demo: true, piArgs: [] }))
    silent.mount(createUpdateCheckPlugin({ enabled: true, delayMs: 20, currentVersion: '0.1.0', fetch: fakeFetch({ tag_name: 'v0.9.0' }) }))
    const silentController = silent.get(workbenchControllerToken)
    await silent.dispose()
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(silentController.getSnapshot().notices).toEqual([])
    await kernel.dispose()
  })
})
