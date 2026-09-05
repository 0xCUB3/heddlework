import { describe, expect, it } from 'bun:test'
import { delimiter, join, resolve } from 'node:path'
import { PiRpcTransport, piProcessEnvironment, resolvePiExecutable } from '../src/pi/rpc-transport.ts'
import { heddleworkFabricBridgePath } from '../src/pi/fabric-bridge.ts'
import type { RpcRecord } from '../src/pi/types.ts'

describe('PiRpcTransport', () => {
  it('prefers Localterm’s credential-injecting shim before generic PATH binaries', () => {
    const home = '/fixture-home'
    const shim = join(home, '.localterm', 'shims', process.platform === 'win32' ? 'pi.exe' : 'pi')
    const generic = join('/generic-bin', process.platform === 'win32' ? 'pi.exe' : 'pi')
    const existing = new Set([shim, generic])
    expect(resolvePiExecutable({ home, path: ['/generic-bin'].join(delimiter), exists: (path) => existing.has(path) })).toBe(shim)
    expect(resolvePiExecutable({ configured: '/explicit/pi', home, path: '', exists: () => false })).toBe('/explicit/pi')
  })

  it('keeps Bun package bins from shadowing Pi behind the LocalTerm shim', () => {
    const cwd = join('/workspace', 'packages', 'app')
    const shim = join('/fixture-home', '.localterm', 'shims', process.platform === 'win32' ? 'pi.exe' : 'pi')
    const packageBins = [
      join('/workspace', 'node_modules', '.bin'),
      join(cwd, 'node_modules', '.bin'),
    ]
    const userBins = [
      join('/toolchains', 'pnpm', 'node_modules', '.bin'),
      join('/fixture-home', '.bun', 'bin'),
      join('/usr', 'bin'),
    ]
    const inherited = { PATH: [...packageBins, ...userBins].join(delimiter) }

    const none = () => false
    expect(piProcessEnvironment(shim, inherited, cwd, '/fixture-home', none).PATH).toBe(userBins.join(delimiter))
    expect(piProcessEnvironment('/explicit/pi', inherited, cwd, '/fixture-home', none)).toBe(inherited)
  })

  it('adds the toolchain directories a Finder-launched app never inherits', () => {
    if (process.platform === 'win32') return
    const home = '/fixture-home'
    const present = new Set(['/opt/homebrew/bin', join(home, '.bun', 'bin'), '/usr/local/bin'])
    const exists = (path: string) => present.has(path)
    // launchd hands GUI apps this PATH; pi's shebang needs node, which lives in /opt/homebrew/bin here.
    const launchd = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
    expect(piProcessEnvironment('/opt/homebrew/bin/pi', launchd, '/workspace', home, exists).PATH)
      .toBe(['/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin', join(home, '.bun', 'bin'), '/usr/local/bin'].join(delimiter))
    // A bare command name gets the candidates appended without a leading entry.
    expect(piProcessEnvironment('pi', launchd, '/workspace', home, exists).PATH)
      .toBe(['/usr/bin', '/bin', '/usr/sbin', '/sbin', join(home, '.bun', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'].join(delimiter))
    // Nothing changes when the shell PATH already carries them.
    const full = { PATH: ['/opt/homebrew/bin', join(home, '.bun', 'bin'), '/usr/local/bin', '/usr/bin'].join(delimiter) }
    expect(piProcessEnvironment('/opt/homebrew/bin/pi', full, '/workspace', home, exists)).toBe(full)
  })

  it('correlates responses while forwarding interleaved events', async () => {
    const events: RpcRecord[] = []
    const transport = new PiRpcTransport({
      cwd: process.cwd(),
      command: process.execPath,
      commandArgs: [resolve(import.meta.dir, 'fixtures/fake-pi.ts')],
    })
    const unsubscribe = transport.onEvent((event) => events.push(event))
    try {
      await transport.start()
      await expect(transport.request<{ pong: boolean }>({ type: 'ping' })).resolves.toEqual({ pong: true })
      expect(events).toHaveLength(1)
      expect(events[0]?.type).toBe('queue_update')
      expect((events[0]?.steering as string[])[0]).toBe('hello\u2028world')
      const argv = await transport.request<{ argv: string[] }>({ type: 'argv' })
      expect(argv.argv).toContain('--mode')
      expect(argv.argv).toContain('rpc')
      expect(argv.argv).toContain('--extension')
      expect(argv.argv).toContain(heddleworkFabricBridgePath())
      await expect(transport.request({ type: 'navigate_tree', entryId: 'entry-1' })).resolves.toEqual({ cancelled: false, editorText: 'Try another branch' })
      await expect(transport.request({ type: 'fail' })).rejects.toThrow('expected failure')
    } finally {
      unsubscribe()
      await transport.stop()
    }
  })
})
