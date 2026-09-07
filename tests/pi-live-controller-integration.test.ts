import { expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverPiLiveBridges, PiLiveBridgeTransport } from '../src/pi/live-bridge.ts'
import { PiRpcTransport } from '../src/pi/rpc-transport.ts'
import { WorkbenchController } from '../src/workbench/controller.ts'
import { testControllerDependencies } from './helpers/workbench.ts'

const pi = process.env.HEDDLEWORK_TEST_PI

it.skipIf(!pi)('a terminal client and the app mutate the same real Pi owner without a second writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-live-controller-'))
  const runtimeDir = join(root, 'runtime')
  const extension = join(root, 'test-command.mjs')
  writeFileSync(extension, `export default function(pi) {
    pi.registerCommand('bridge-integration', {description:'Offline integration command', handler:async(args)=>pi.setSessionName(args)});
  }`)
  const transport = new PiRpcTransport({
    cwd: root, command: pi!, requestTimeoutMs: 2_000,
    env: { PI_CODING_AGENT_DIR: join(root, 'agent'), HEDDLEWORK_RUNTIME_DIR: runtimeDir },
    piArgs: ['--offline', '--no-session', '--extension', extension],
  })
  const controller = new WorkbenchController(transport, root, testControllerDependencies())
  let terminal: PiLiveBridgeTransport | undefined
  try {
    await controller.start()
    expect(controller.getSnapshot().connection).toBe('connected')
    let owners = discoverPiLiveBridges(join(runtimeDir, 'pi-live'))
    const deadline = Date.now() + 2_000
    while (!owners.length && Date.now() < deadline) {
      await Bun.sleep(10)
      owners = discoverPiLiveBridges(join(runtimeDir, 'pi-live'))
    }
    expect(owners).toHaveLength(1)
    terminal = new PiLiveBridgeTransport({ advertisement: owners[0]!, requestTimeoutMs: 2_000 })
    await terminal.start()
    await terminal.request({ type: 'prompt', message: '/bridge-integration Named from terminal' })
    const renameDeadline = Date.now() + 2_000
    while (controller.getSnapshot().session.sessionName !== 'Named from terminal' && Date.now() < renameDeadline) await Bun.sleep(10)
    expect(controller.getSnapshot().session.sessionName).toBe('Named from terminal')
    await controller.renameThread('Named from app')
    expect((await terminal.request<{ sessionName: string }>({ type: 'get_state' })).sessionName).toBe('Named from app')
    expect(discoverPiLiveBridges(join(runtimeDir, 'pi-live')).map((owner) => owner.pid)).toEqual([owners[0]!.pid])
    await terminal.stop()
    expect((await transport.request<{ sessionId: string }>({ type: 'get_state' })).sessionId).toBe(owners[0]!.sessionId)
  } finally {
    await terminal?.stop()
    await controller.dispose()
    rmSync(root, { recursive: true, force: true })
  }
}, 15_000)
