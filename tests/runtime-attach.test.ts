import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isRuntimeSettingsResponse, nextRuntimeControlRequestId } from '../src/runtime/control-protocol.ts'
import { createShellWorkbenchController, waitForWorkspaceClientOpen } from '../src/client/runtime-attach.ts'
import { attachOrStartRuntime } from '../src/runtime/bootstrap.ts'
import { PROTOCOL_VERSION } from '../src/protocol/version.ts'
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

describe('shell-first runtime attach', () => {
  const directories: string[] = []
  afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
  })

  it('reuses a compatible runtime without hashing or staging', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'heddlework-attach-reuse-'))
    directories.push(directory)
    const instanceId = 'live-instance'
    writeFileSync(join(directory, 'connection.json'), JSON.stringify({
      pid: process.pid,
      instanceId,
      protocol: PROTOCOL_VERSION,
      version: 'test',
      executable: '/does-not-exist/heddlework-runtime',
      url: 'http://127.0.0.1:9',
      controlUrl: 'http://127.0.0.1:9',
      token: 'token',
      workspacePath: directory,
      supervisor: 'process',
    }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(JSON.stringify({
      instanceId,
      busy: false,
      protocol: PROTOCOL_VERSION,
      version: 'test',
    }))) as unknown as typeof fetch
    try {
      const descriptor = await attachOrStartRuntime({
        workspacePath: directory,
        directory,
        executable: join(directory, 'missing-source-would-throw-if-hashed'),
        timeoutMs: 1_000,
      })
      expect(descriptor.instanceId).toBe(instanceId)
      expect(descriptor.pid).toBe(process.pid)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('renders connecting chrome without a live controller', async () => {
    const sessions = [{
      id: 'one',
      path: '/tmp/one.jsonl',
      cwd: '/tmp/project',
      title: 'Cached thread',
      firstMessage: 'Hello',
      messageCount: 1,
      createdAt: 1,
      modifiedAt: 1,
    }]
    const shell = createShellWorkbenchController('/tmp/project', { sessions })
    expect(shell.getSnapshot().connection).toBe('connecting')
    expect(shell.getSnapshot().sessions[0]?.title).toBe('Cached thread')
    shell.setEditorText('typed locally')
    expect(shell.getSnapshot().editorText).toBe('typed locally')
    await shell.switchSession(sessions[0]!)
    expect(shell.getSnapshot().session.sessionFile).toBe('/tmp/one.jsonl')
    expect(shell.getSnapshot().activity).toBe('Opening thread')
    await shell.dispose()
  })
})

