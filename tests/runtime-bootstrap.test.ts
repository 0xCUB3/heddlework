import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { acquireProcessLock, processAlive, tryProcessLock } from '../src/runtime/process-lock.ts'
import { launchAgentPlist, stageRuntimeExecutable } from '../src/runtime/bootstrap.ts'
import { writePrivateJson } from '../src/runtime/paths.ts'

const directories: string[] = []
function temporary() { const path = mkdtempSync(join(tmpdir(), 'hw-runtime-')); directories.push(path); return path }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe('background runtime bootstrap', () => {
  it('admits only one owner and waits for release', async () => {
    const path = join(temporary(), 'owner.lock')
    const release = tryProcessLock(path)!
    expect(release).toBeFunction()
    expect(tryProcessLock(path)).toBeUndefined()
    const next = acquireProcessLock(path, 1000)
    setTimeout(release, 30)
    const second = await next
    expect(existsSync(path)).toBe(true)
    release()
    expect(existsSync(path)).toBe(true)
    second()
    const third = tryProcessLock(path)!
    expect(third).toBeFunction()
    third()
  })
  it('recovers dead owners without a stale-file deletion race', () => {
    const path = join(temporary(), 'owner.lock')
    writeFileSync(path, JSON.stringify({ pid: 2147483647 }))
    expect(processAlive(2147483647)).toBe(false)
    const release = tryProcessLock(path)!
    expect(release).toBeFunction()
    release()
    if (process.platform !== 'win32') {
      writeFileSync(path, '')
      const recovered = tryProcessLock(path)!
      expect(recovered).toBeFunction()
      recovered()
    }
  })
  it('releases ownership after a hard process crash', async () => {
    const path = join(temporary(), 'owner.lock')
    const module = resolve(import.meta.dir, '../src/runtime/process-lock.ts')
    const code = `const {tryProcessLock}=await import(${JSON.stringify(module)}); const release=tryProcessLock(process.env.LOCK_PATH); if(!release)process.exit(2); console.log('locked'); setInterval(()=>{},1000)`
    const child = Bun.spawn([process.execPath, '-e', code], { env: { ...process.env, LOCK_PATH: path }, stdout: 'pipe', stderr: 'pipe' })
    try {
      const reader = child.stdout.getReader()
      const first = await reader.read()
      reader.releaseLock()
      expect(new TextDecoder().decode(first.value)).toContain('locked')
      expect(tryProcessLock(path)).toBeUndefined()
      child.kill('SIGKILL')
      await child.exited
      const release = tryProcessLock(path)!
      expect(release).toBeFunction()
      release()
    } finally { child.kill(); await child.exited }
  })
  it('stages executable and resources outside the replaceable bundle', () => {
    const root = temporary()
    const bundle = join(root, 'bundle')
    mkdirSync(join(bundle, 'web'), { recursive: true })
    const source = join(bundle, 'heddlework-runtime')
    writeFileSync(source, 'runtime-one')
    writeFileSync(join(bundle, 'web/index.html'), 'web-one')
    const pinned = stageRuntimeExecutable(source, join(root, 'state'))
    expect(stageRuntimeExecutable(source, join(root, 'state'))).toBe(pinned)
    writeFileSync(source, 'runtime-two')
    const updated = stageRuntimeExecutable(source, join(root, 'state'))
    expect(updated).not.toBe(pinned)
    writeFileSync(join(bundle, 'web/index.html'), 'web-two')
    const webUpdated = stageRuntimeExecutable(source, join(root, 'state'))
    expect(webUpdated).not.toBe(updated)
    expect(readFileSync(join(webUpdated, '../web/index.html'), 'utf8')).toBe('web-two')
    rmSync(bundle, { recursive: true })
    expect(readFileSync(pinned, 'utf8')).toBe('runtime-one')
    expect(readFileSync(join(pinned, '../web/index.html'), 'utf8')).toBe('web-one')
    expect(readFileSync(updated, 'utf8')).toBe('runtime-two')
  })
  it('writes owner-only discovery metadata atomically', () => {
    const path = join(temporary(), 'private/connection.json')
    writePrivateJson(path, { token: 'secret', pid: process.pid })
    expect(JSON.parse(readFileSync(path, 'utf8')).pid).toBe(process.pid)
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600)
      expect(statSync(join(path, '..')).mode & 0o777).toBe(0o700)
    }
  })
  it('launchd restarts crashes but respects deliberate successful stops', () => {
    const plist = launchAgentPlist('test.agent', '/private/a & b/runtime', '/private/state', '/workspace', { PATH: '/bin' })
    expect(plist).toContain('/private/a &amp; b/runtime')
    expect(plist).toContain('<key>SuccessfulExit</key><false/>')
    expect(plist).toContain('<key>RunAtLoad</key><true/>')
    expect(plist).not.toContain('OPENAI_API_KEY')
  })
})
