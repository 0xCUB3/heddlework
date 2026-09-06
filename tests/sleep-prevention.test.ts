import { describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { hostWorkIsRunning, shouldInhibitSleep } from '../src/power/activity.ts'
import {
  caffeinateArgs,
  createPlatformSleepBackend,
  createRecordingSleepBackend,
  systemdInhibitArgs,
  windowsExecutionState,
  ES_CONTINUOUS,
  ES_DISPLAY_REQUIRED,
  ES_SYSTEM_REQUIRED,
  type SleepSpawnFn,
} from '../src/power/backends.ts'
import { parseSleepPreventionPolicy } from '../src/power/types.ts'
import { readSleepPreventionPolicy, writeSleepPreventionPolicy } from '../src/power/preferences.ts'
import { SleepPreventionService } from '../src/power/service.ts'
import { createInitialState, type WorkbenchState } from '../src/workbench/state.ts'
import { applyWorkbenchCommand, isSleepPreventionCommand, isWorkbenchCommand } from '../src/protocol/commands.ts'
import { WorkbenchKernel } from '../src/core/kernel.ts'
import { createFlowRuntimePlugin } from '../src/flows/plugin.ts'
import { createSleepPreventionPlugin, sleepPreventionToken } from '../src/power/plugin.ts'
import {
  createAgentTransportPlugin,
  createSessionCatalogPlugin,
  createWorkbenchControllerPlugin,
  localWorkspaceDiffPlugin,
  workbenchControllerToken,
} from '../src/workbench/plugins.ts'

function source(state: WorkbenchState = createInitialState('/tmp/heddlework-sleep')) {
  let current = state
  const listeners = new Set<() => void>()
  return {
    controller: {
      subscribe(listener: () => void) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
      getSnapshot: () => current,
    },
    patch(next: {
      session?: Partial<WorkbenchState['session']>
      activity?: WorkbenchState['activity']
      liveTools?: WorkbenchState['liveTools']
      queue?: Partial<WorkbenchState['queue']>
    }) {
      current = {
        ...current,
        ...(next.activity !== undefined ? { activity: next.activity } : {}),
        session: { ...current.session, ...next.session },
        queue: { ...current.queue, ...next.queue },
        liveTools: next.liveTools ?? current.liveTools,
      }
      for (const listener of listeners) listener()
    },
  }
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${label}`)
}

describe('sleep prevention policy', () => {
  it('defaults while-working with display sleep still allowed and migrates junk', () => {
    expect(parseSleepPreventionPolicy(undefined)).toEqual({ when: 'whileWorking', keepDisplayAwake: false })
    expect(parseSleepPreventionPolicy({ when: 'nope', keepDisplayAwake: 'yes' })).toEqual({ when: 'whileWorking', keepDisplayAwake: false })
    expect(parseSleepPreventionPolicy({ when: 'off', keepDisplayAwake: true })).toEqual({ when: 'off', keepDisplayAwake: true })
  })

  it('merges into existing preferences.json', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hw-sleep-pref-')), 'preferences.json')
    writeFileSync(path, JSON.stringify({ theme: 'dark' }))
    expect(readSleepPreventionPolicy(path)).toEqual({ when: 'whileWorking', keepDisplayAwake: false })
    writeSleepPreventionPolicy({ when: 'whileAppOpen', keepDisplayAwake: true }, path)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      theme: 'dark',
      sleepPrevention: { when: 'whileAppOpen', keepDisplayAwake: true },
    })
    expect(readSleepPreventionPolicy(path)).toEqual({ when: 'whileAppOpen', keepDisplayAwake: true })
    expect(readSleepPreventionPolicy(false)).toEqual({ when: 'whileWorking', keepDisplayAwake: false })
  })
})

describe('host work activity', () => {
  it('treats streaming, tools, compaction, dispatch, and running browser tasks as work', () => {
    expect(hostWorkIsRunning({})).toBe(false)
    expect(hostWorkIsRunning({ isStreaming: true })).toBe(true)
    expect(hostWorkIsRunning({ activity: 'Compacting context' })).toBe(true)
    expect(hostWorkIsRunning({ activity: 'Retrying' })).toBe(true)
    expect(hostWorkIsRunning({ liveTools: [{ status: 'running' }] })).toBe(true)
    expect(hostWorkIsRunning({ liveTools: [{ status: 'complete' }] })).toBe(false)
    expect(hostWorkIsRunning({ dispatching: true })).toBe(true)
    expect(hostWorkIsRunning({ browserTaskStatus: 'running' })).toBe(true)
    expect(hostWorkIsRunning({ browserTaskStatus: 'review' })).toBe(false)
    expect(hostWorkIsRunning({ flowTaskStatuses: ['queued', 'paused'] })).toBe(false)
    expect(hostWorkIsRunning({ flowTaskStatuses: ['running'] })).toBe(true)
    expect(shouldInhibitSleep('off', true)).toBe(false)
    expect(shouldInhibitSleep('whileWorking', false)).toBe(false)
    expect(shouldInhibitSleep('whileWorking', true)).toBe(true)
    expect(shouldInhibitSleep('whileAppOpen', false)).toBe(true)
  })
})

describe('platform backends', () => {
  it('builds caffeinate, systemd-inhibit, and Windows flags without a shell', () => {
    expect(caffeinateArgs({ keepDisplayAwake: false, parentPid: 99 })).toEqual(['-i', '-w', '99'])
    expect(caffeinateArgs({ keepDisplayAwake: true, parentPid: 99 })).toEqual(['-i', '-d', '-w', '99'])
    expect(systemdInhibitArgs()).toEqual([
      '--what=sleep:idle',
      '--who=Heddlework',
      '--why=Heddlework is running',
      '--mode=block',
      '/bin/cat',
    ])
    expect(windowsExecutionState(false)).toBe((ES_CONTINUOUS | ES_SYSTEM_REQUIRED) >>> 0)
    expect(windowsExecutionState(true)).toBe((ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED) >>> 0)
  })

  it('selects platform backends and reports missing binaries as unsupported', () => {
    const spawned: Array<{ command: string; args: readonly string[] }> = []
    const spawn = mockSpawn(spawned)
    const mac = createPlatformSleepBackend({ platform: 'darwin', parentPid: 7, exists: (path) => path === '/usr/bin/caffeinate', spawn })
    expect(mac).toMatchObject({ name: 'caffeinate', supported: true, displaySupported: true })
    const linux = createPlatformSleepBackend({ platform: 'linux', exists: (path) => path === '/usr/bin/systemd-inhibit' || path === '/bin/cat', spawn })
    expect(linux).toMatchObject({ name: 'systemd-inhibit', supported: true, displaySupported: false })
    const missing = createPlatformSleepBackend({ platform: 'linux', exists: () => false, spawn })
    expect(missing.supported).toBe(false)
    const win = createPlatformSleepBackend({ platform: 'win32', windowsSetThreadExecutionState: () => 1 })
    expect(win).toMatchObject({ name: 'execution-state', displaySupported: true })
    const other = createPlatformSleepBackend({ platform: 'freebsd' })
    expect(other.supported).toBe(false)
  })

  it('spawns caffeinate and systemd-inhibit with owned children', async () => {
    const spawned: Array<{ command: string; args: readonly string[]; child: ReturnType<typeof fakeChild> }> = []
    const spawn: SleepSpawnFn = (command, args) => {
      const child = fakeChild()
      spawned.push({ command, args, child })
      queueMicrotask(() => child.emitSpawn())
      return child as unknown as ChildProcess
    }
    const mac = createPlatformSleepBackend({ platform: 'darwin', parentPid: 11, exists: () => true, spawn })
    const held = await mac.acquire({ keepDisplayAwake: true })
    expect(spawned[0]).toMatchObject({ command: '/usr/bin/caffeinate', args: ['-i', '-d', '-w', '11'] })
    await held.release()
    expect(spawned[0]?.child.killed).toBe(true)

    const linux = createPlatformSleepBackend({ platform: 'linux', exists: () => true, spawn })
    const linuxHeld = await linux.acquire({ keepDisplayAwake: true })
    expect(spawned[1]).toMatchObject({ command: '/usr/bin/systemd-inhibit', args: systemdInhibitArgs() })
    await linuxHeld.release()
    expect(spawned[1]?.child.stdinEnded).toBe(true)
  })

  it('clears Windows execution state on the same helper', async () => {
    const calls: number[] = []
    const backend = createPlatformSleepBackend({
      platform: 'win32',
      windowsSetThreadExecutionState: (flags) => {
        calls.push(flags >>> 0)
        return 1
      },
    })
    const held = await backend.acquire({ keepDisplayAwake: true })
    await held.release()
    expect(calls[0]).toBe(windowsExecutionState(true))
    expect(calls[1]).toBe(ES_CONTINUOUS)
  })
})

describe('sleep prevention service', () => {
  it('does not hold when off or idle, and holds for every running work source', async () => {
    const work = source()
    const backend = createRecordingSleepBackend()
    const browser = browserSource()
    const service = new SleepPreventionService({
      controller: work.controller,
      browserIntegrations: browser,
      backend,
      preferencePath: false,
      releaseDebounceMs: 0,
    })
    await waitFor(() => service.getSnapshot().status === 'idle', 'idle after boot')
    expect(backend.active).toBe(0)

    work.patch({ session: { isStreaming: true }, activity: 'Working' })
    await waitFor(() => backend.active === 1, 'streaming hold')
    work.patch({ session: { isStreaming: false }, activity: 'Ready' })
    await waitFor(() => backend.active === 0, 'release after settle')

    work.patch({ liveTools: [{ id: 't', name: 'bash', status: 'running', isError: false }] })
    await waitFor(() => backend.active === 1, 'tool hold')
    work.patch({ liveTools: [{ id: 't', name: 'bash', status: 'complete', isError: false }] })
    await waitFor(() => backend.active === 0, 'tool complete')

    work.patch({ activity: 'Compacting context' })
    await waitFor(() => backend.active === 1, 'compaction hold')
    work.patch({ activity: 'Ready' })
    await waitFor(() => backend.active === 0, 'compaction end')

    work.patch({ queue: { ...work.controller.getSnapshot().queue, dispatchingId: 'q1' } })
    await waitFor(() => backend.active === 1, 'dispatch hold')
    work.patch({ queue: { ...work.controller.getSnapshot().queue, dispatchingId: undefined } })
    await waitFor(() => backend.active === 0, 'dispatch end')

    browser.patch({ status: 'running' })
    await waitFor(() => backend.active === 1, 'browser task hold')
    browser.patch({ status: 'completed' })
    await waitFor(() => backend.active === 0, 'browser task end')

    service.setPolicy({ when: 'off', keepDisplayAwake: false })
    work.patch({ session: { isStreaming: true }, activity: 'Working' })
    await Bun.sleep(20)
    expect(backend.active).toBe(0)

    service.setPolicy({ when: 'whileAppOpen', keepDisplayAwake: false })
    work.patch({ session: { isStreaming: false }, activity: 'Ready' })
    await waitFor(() => backend.active === 1, 'app-open hold while idle')
    await service.dispose()
    expect(backend.active).toBe(0)
  })

  it('releases on settings change and dispose, and does not respawn while already holding', async () => {
    const work = source({ ...createInitialState('/tmp/heddlework-sleep'), session: { model: null, thinkingLevel: 'off', isStreaming: true }, activity: 'Working' })
    const backend = createRecordingSleepBackend()
    const service = new SleepPreventionService({ controller: work.controller, backend, preferencePath: false, releaseDebounceMs: 0 })
    await waitFor(() => backend.active === 1, 'initial hold')
    const acquires = backend.acquires.length
    work.patch({ activity: 'Thinking' })
    await Bun.sleep(20)
    expect(backend.acquires.length).toBe(acquires)
    service.setPolicy({ when: 'off', keepDisplayAwake: false })
    await waitFor(() => backend.active === 0, 'off releases')
    await service.dispose()
    expect(backend.active).toBe(0)
  })

  it('debounces brief idle gaps without a spawn storm', async () => {
    const work = source({ ...createInitialState('/tmp/heddlework-sleep'), session: { model: null, thinkingLevel: 'off', isStreaming: true }, activity: 'Working' })
    const backend = createRecordingSleepBackend()
    const service = new SleepPreventionService({ controller: work.controller, backend, preferencePath: false, releaseDebounceMs: 80 })
    await waitFor(() => backend.active === 1, 'hold')
    work.patch({ session: { isStreaming: false }, activity: 'Ready' })
    await Bun.sleep(20)
    expect(backend.active).toBe(1)
    work.patch({ session: { isStreaming: true }, activity: 'Working' })
    await Bun.sleep(100)
    expect(backend.active).toBe(1)
    expect(backend.acquires.length).toBe(1)
    await service.dispose()
  })

  it('surfaces backend errors without crashing and stops after bounded restarts', async () => {
    const work = source()
    const backend = createRecordingSleepBackend()
    backend.failNext = 'caffeinate missing'
    const service = new SleepPreventionService({
      controller: work.controller,
      backend,
      preferencePath: false,
      releaseDebounceMs: 0,
    })
    service.setPolicy({ when: 'whileAppOpen', keepDisplayAwake: false })
    await waitFor(() => service.getSnapshot().status === 'error', 'error status')
    expect(service.getSnapshot().error).toContain('caffeinate missing')
    expect(service.getSnapshot().inhibiting).toBe(false)
    await service.dispose()
  })

  it('restarts display vs system holds when the display option changes', async () => {
    const work = source()
    const backend = createRecordingSleepBackend()
    const service = new SleepPreventionService({ controller: work.controller, backend, preferencePath: false, releaseDebounceMs: 0 })
    service.setPolicy({ when: 'whileAppOpen', keepDisplayAwake: false })
    await waitFor(() => backend.acquires.at(-1)?.keepDisplayAwake === false, 'system hold')
    service.setPolicy({ when: 'whileAppOpen', keepDisplayAwake: true })
    await waitFor(() => backend.acquires.at(-1)?.keepDisplayAwake === true && backend.active === 1, 'display hold')
    expect(backend.releases).toBeGreaterThanOrEqual(1)
    await service.dispose()
  })
})

describe('sleep prevention protocol', () => {
  it('validates the host policy command and applies it through the service', async () => {
    expect(isSleepPreventionCommand({ type: 'setSleepPreventionPolicy', when: 'off', keepDisplayAwake: true })).toBe(true)
    expect(isWorkbenchCommand({ type: 'setSleepPreventionPolicy', when: 'nope', keepDisplayAwake: false })).toBe(false)
    const kernel = new WorkbenchKernel()
    kernel.mount(createWorkbenchControllerPlugin('/tmp/heddlework-sleep-cmd'))
    kernel.mount(createFlowRuntimePlugin({ path: false, tickIntervalMs: 60_000 }))
    const backend = createRecordingSleepBackend()
    kernel.mount(createSleepPreventionPlugin({ preferencePath: false, backend, releaseDebounceMs: 0 }))
    kernel.mount(createSessionCatalogPlugin({ scope: 'cwd' }))
    kernel.mount(localWorkspaceDiffPlugin)
    kernel.mount(createAgentTransportPlugin({ cwd: '/tmp/heddlework-sleep-cmd', demo: true, piArgs: [] }))
    const controller = kernel.get(workbenchControllerToken)
    const sleep = kernel.get(sleepPreventionToken)
    await controller.start()
    await applyWorkbenchCommand(controller, { type: 'setSleepPreventionPolicy', when: 'whileAppOpen', keepDisplayAwake: true }, { sleepPrevention: sleep })
    await waitFor(() => sleep.getSnapshot().policy.when === 'whileAppOpen' && backend.active === 1, 'command hold')
    await kernel.dispose()
    expect(backend.active).toBe(0)
  })
})

function browserSource() {
  let task: { status: string } | null = null
  const listeners = new Set<() => void>()
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => ({
      choices: [],
      selectedId: 'builtin',
      profile: '',
      task: task ? { id: 'task', integrationId: 'test', profile: '', prompt: '', status: task.status as 'running' | 'completed', output: '', expiresAt: 0 } : null,
      error: null,
    }),
    patch(next: { status: string } | null) {
      task = next
      for (const listener of listeners) listener()
    },
  }
}

function fakeChild() {
  const emitter = new EventEmitter()
  const child = {
    pid: 4242,
    killed: false,
    exitCode: null as number | null,
    stdinEnded: false,
    stdin: { end() { child.stdinEnded = true } },
    stderr: { on() { return child.stderr } },
    once(event: string, listener: (...args: unknown[]) => void) {
      emitter.once(event, listener)
      return child
    },
    off(event: string, listener: (...args: unknown[]) => void) {
      emitter.off(event, listener)
      return child
    },
    kill() {
      child.killed = true
      child.exitCode = 0
      emitter.emit('exit', 0)
      return true
    },
    emitSpawn() { emitter.emit('spawn') },
  }
  return child
}

function mockSpawn(spawned: Array<{ command: string; args: readonly string[] }>): SleepSpawnFn {
  return (command, args) => {
    spawned.push({ command, args })
    const child = fakeChild()
    queueMicrotask(() => child.emitSpawn())
    return child as unknown as ChildProcess
  }
}
