import { describe, expect, it } from 'bun:test'
import { isRuntimeSettingsResponse, nextRuntimeControlRequestId } from '../src/runtime/control-protocol.ts'
import { waitForWorkspaceClientOpen } from '../src/client/runtime-attach.ts'
import { WorkspaceClient } from '../src/web/client.ts'

describe('runtime control protocol', () => {
  it('parses ok/error settings responses', () => {
    expect(isRuntimeSettingsResponse({ requestId: 'a', ok: true, status: { workspacePath: '/w', remote: { mode: 'off', busy: false }, tailnet: { status: 'idle', enabled: false, busy: false, availablePorts: [], conflicts: [], message: '', magicDnsEnabled: false }, remotes: [] } })).toBe(true)
    expect(isRuntimeSettingsResponse({ requestId: 'a', ok: false, error: 'nope' })).toBe(true)
    expect(isRuntimeSettingsResponse({ ok: true })).toBe(false)
  })

  it('generates unique request ids', () => {
    expect(nextRuntimeControlRequestId()).not.toBe(nextRuntimeControlRequestId())
  })
})

describe('waitForWorkspaceClientOpen', () => {
  it('resolves when the client is already open', async () => {
    const client = new WorkspaceClient()
    client.connect('http://127.0.0.1:9', 'token')
    ;(client as unknown as { getSnapshot(): unknown }).getSnapshot = () => ({ status: 'open', workspacePath: '/tmp', state: { workspacePath: '/tmp' }, flows: undefined })
    const view = await waitForWorkspaceClientOpen(client, { timeoutMs: 50 })
    expect(view.status).toBe('open')
    client.disconnect()
  })
})

