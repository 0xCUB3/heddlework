import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BrowserIntegrationService, createBrowserTaskAdapters, loadCustomBrowserAdapters, type BrowserTaskAdapter } from '../src/browser/integrations.ts'
import { runBrowserProcess, type BrowserProcessRequest } from '../src/browser/integration-process.ts'
import { isBrowserIntegrationCommand } from '../src/browser/integration-types.ts'

const disposals: Array<() => void> = []
afterEach(() => { for (const dispose of disposals.splice(0)) dispose() })
function adapter(run: BrowserTaskAdapter['run'] = async ({ onOutput }) => { onOutput('Result') }): BrowserTaskAdapter {
  return { choice: { id: 'test', label: 'Test', available: true, description: 'Test profile' }, run }
}
function service(options: Partial<ConstructorParameters<typeof BrowserIntegrationService>[0]> = {}) {
  const value = new BrowserIntegrationService({ adapters: [adapter()], ...options })
  disposals.push(() => value.dispose())
  return value
}
function choose(value: BrowserIntegrationService) { value.dispatch({ type: 'selectBrowserIntegration', integrationId: 'test', profile: 'work' }) }
function request(value: BrowserIntegrationService) {
  value.dispatch({ type: 'requestBrowserTask', prompt: 'Read example.com only' })
  return value.getSnapshot().task!.id
}
async function settled(value: BrowserIntegrationService) {
  for (let i = 0; i < 100 && value.getSnapshot().task?.status === 'running'; i++) await Bun.sleep(5)
}

describe('browser integration approval boundary', () => {
  it('does not execute on selection/request and consumes exact approval once', async () => {
    let calls = 0
    const value = service({ adapters: [adapter(async ({ profile, prompt, onOutput }) => { calls++; expect(profile).toBe('work'); expect(prompt).toBe('Read example.com only'); onOutput('Result') })] })
    expect(() => request(value)).toThrow('external browser')
    choose(value)
    const id = request(value)
    expect(calls).toBe(0)
    expect(() => value.dispatch({ type: 'approveBrowserTask', id: 'wrong' })).toThrow()
    value.dispatch({ type: 'approveBrowserTask', id })
    expect(() => value.dispatch({ type: 'approveBrowserTask', id })).toThrow()
    await settled(value)
    expect(calls).toBe(1)
    expect(value.getSnapshot().task?.output).toBe('Result')
    expect(value.getSnapshot().task?.status).toBe('completed')
  })
  it('invalidates pending approval on profile changes and expiry', () => {
    let now = 0
    const value = service({ now: () => now })
    choose(value)
    const old = request(value)
    choose(value)
    expect(value.getSnapshot().task).toBeNull()
    expect(() => value.dispatch({ type: 'approveBrowserTask', id: old })).toThrow()
    const id = request(value)
    now = 300001
    expect(() => value.dispatch({ type: 'approveBrowserTask', id })).toThrow('expired')
    value.dispatch({ type: 'cancelBrowserTask', id })
    expect(value.getSnapshot().task?.status).toBe('cancelled')
  })
  it('stops local work without falsely claiming remote cancellation or accepting stale output', async () => {
    let emit: (text: string) => void = () => {}
    let aborted = false
    const value = service({ adapters: [adapter(({ signal, onOutput }) => new Promise(resolve => {
      emit = onOutput
      signal.addEventListener('abort', () => { aborted = true; resolve() })
    }))] })
    choose(value)
    const id = request(value)
    value.dispatch({ type: 'approveBrowserTask', id })
    await Bun.sleep(0)
    expect(() => choose(value)).toThrow()
    expect(() => value.dispatch({ type: 'clearBrowserTask' })).toThrow()
    value.dispatch({ type: 'cancelBrowserTask', id })
    expect(aborted).toBe(true)
    emit('late secret')
    await Bun.sleep(0)
    expect(value.getSnapshot().task?.status).toBe('detached')
    expect(value.getSnapshot().task?.output).not.toContain('late secret')
    value.dispatch({ type: 'clearBrowserTask' })
    expect(value.getSnapshot().task).toBeNull()
  })
  it('expires a running wait and reports adapter failures', async () => {
    const value = service({ timeoutMs: 5, adapters: [adapter(async () => { await Bun.sleep(30) })] })
    choose(value); value.dispatch({ type: 'approveBrowserTask', id: request(value) })
    await settled(value)
    expect(value.getSnapshot().task?.status).toBe('detached')
    const failing = service({ adapters: [adapter(async () => { throw new Error('Not logged in') })] })
    choose(failing); failing.dispatch({ type: 'approveBrowserTask', id: request(failing) })
    await settled(failing)
    expect(failing.getSnapshot().task?.status).toBe('failed')
    expect(failing.getSnapshot().task?.output).toContain('Not logged in')
  })
  it('saves selection only and never restores an execution grant or result', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-browser-'))
    disposals.push(() => rmSync(dir, { recursive: true, force: true }))
    const preferencePath = join(dir, 'selection.json')
    const value = service({ preferencePath }); choose(value)
    value.dispatch({ type: 'approveBrowserTask', id: request(value) }); await settled(value)
    expect(JSON.parse(readFileSync(preferencePath, 'utf8'))).toEqual({ integrationId: 'test', profile: 'work' })
    const restored = service({ preferencePath })
    expect(restored.getSnapshot().selectedId).toBe('test')
    expect(restored.getSnapshot().task).toBeNull()
    expect(JSON.stringify(restored.getSnapshot())).not.toContain('command')
  })
  it('rejects malformed wire payloads and unknown/profile-less selections', () => {
    for (const bad of [null, { type: 'requestBrowserTask', prompt: 4 }, { type: 'requestBrowserTask', prompt: ' ' }, { type: 'approveBrowserTask' }, { type: 'selectBrowserIntegration', integrationId: 'test', profile: {} }]) expect(isBrowserIntegrationCommand(bad)).toBe(false)
    const value = service()
    expect(() => value.dispatch({ type: 'selectBrowserIntegration', integrationId: 'unregistered', profile: 'u0' })).toThrow()
    expect(() => value.dispatch({ type: 'selectBrowserIntegration', integrationId: 'test', profile: '' })).toThrow()
  })
})

describe('browser executable adapters', () => {
  it('pins Aside host/account and passes hostile prompt as one argument without a shell', async () => {
    const captured: BrowserProcessRequest[] = []
    const adapters = createBrowserTaskAdapters([], async request => { captured.push(request) }, process.execPath)
    const aside = adapters[0]!
    const prompt = '--permission full-access; $(touch /tmp/DO-NOT-CREATE)'
    await aside.run({ profile: 'u2', prompt, signal: new AbortController().signal, onOutput() {} })
    expect(captured[0]!.args.slice(0, 8)).toEqual(['exec', '--host', 'local', '--account', 'u2', '--permission', 'guard', '--'])
    expect(captured[0]!.args).toHaveLength(9)
    expect(captured[0]!.args[8]).toContain(prompt)
    expect(() => aside.run({ profile: '', prompt, signal: new AbortController().signal, onOutput() {} })).toThrow('explicit Aside account')
  })
  it('validates host config and executes a real custom process using JSON stdin', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hw-adapter-'))
    disposals.push(() => rmSync(dir, { recursive: true, force: true }))
    const path = join(dir, 'integrations.json')
    const config = { version: 1, adapters: [{ id: 'custom', label: 'Custom', command: process.execPath, args: ['-e', 'const r=JSON.parse(await Bun.stdin.text()); console.log(r.version+":"+r.profile+":"+r.prompt)'], description: 'Test only' }] }
    writeFileSync(path, JSON.stringify(config))
    const loaded = loadCustomBrowserAdapters(path)
    const custom = createBrowserTaskAdapters(loaded).find(a => a.choice.id === 'custom')!
    let output = ''
    await custom.run({ profile: 'work', prompt: 'literal $(echo hello)', signal: new AbortController().signal, onOutput: text => { output += text } })
    expect(output.trim()).toBe('1:work:literal $(echo hello)')
    config.adapters[0]!.command = 'relative-executable'
    writeFileSync(path, JSON.stringify(config))
    expect(() => loadCustomBrowserAdapters(path)).toThrow('absolute executables')
    config.adapters[0]!.command = process.execPath; config.adapters[0]!.id = 'aside'
    writeFileSync(path, JSON.stringify(config))
    expect(() => loadCustomBrowserAdapters(path)).toThrow()
  })
  it('bounds output and handles pre-aborted processes', async () => {
    await expect(runBrowserProcess({ command: process.execPath, args: ['-e', 'console.log("x".repeat(140000))'], signal: new AbortController().signal, onOutput() {} })).rejects.toThrow('output limit')
    const abort = new AbortController(); abort.abort()
    await expect(runBrowserProcess({ command: process.execPath, args: [], signal: abort.signal, onOutput() {} })).rejects.toThrow('interrupted')
  })
})
