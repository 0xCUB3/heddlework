import { expect, it } from 'bun:test'
import { spawn } from 'node:child_process'
import { createPlatformSleepBackend } from '../src/power/backends.ts'

const mac = process.platform === 'darwin' ? it : it.skip

function pmsetAssertions(): string {
  return Bun.spawnSync(['/usr/bin/pmset', '-g', 'assertions'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString()
}

async function waitForAssertion(pid: number, present: boolean): Promise<string> {
  const deadline = Date.now() + 2_000
  let assertions = pmsetAssertions()
  // The child spawn event precedes registration with powerd. Poll the actual
  // OS state, not an arbitrary delay or a different process's assertion.
  while (assertions.includes(`pid ${pid}(`) !== present && Date.now() < deadline) {
    await Bun.sleep(20)
    assertions = pmsetAssertions()
  }
  return assertions
}

mac('acquires a real caffeinate assertion and releases it', async () => {
  const before = pmsetAssertions()
  const backend = createPlatformSleepBackend({ parentPid: process.pid })
  expect(backend.name).toBe('caffeinate')
  const held = await backend.acquire({ keepDisplayAwake: false })
  try {
    expect(held.pid).toBeNumber()
    const during = await waitForAssertion(held.pid!, true)
    expect(during).toContain('PreventUserIdleSystemSleep')
    expect(during).toContain(`pid ${held.pid}(`)
    expect(during).toContain('caffeinate')
  } finally {
    await held.release()
  }
  const after = await waitForAssertion(held.pid!, false)
  if (held.pid) expect(after.includes(`pid ${held.pid}(`)).toBe(false)
  if (!before.includes('PreventUserIdleSystemSleep')) expect(after.includes(`pid ${held.pid}(`) || false).toBe(false)
})

mac('caffeinate -w exits when the watched parent dies', async () => {
  const sleeper = spawn('/bin/sleep', ['30'], { stdio: 'ignore' })
  const pid = sleeper.pid
  expect(pid).toBeNumber()
  const cafe = spawn('/usr/bin/caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' })
  const cafePid = cafe.pid
  expect(cafePid).toBeNumber()
  const exited = new Promise<number | null>((resolve) => cafe.once('exit', (code) => resolve(code)))
  sleeper.kill('SIGTERM')
  const code = await Promise.race([exited, Bun.sleep(3_000).then(() => 'timeout' as const)])
  if (code === 'timeout') {
    cafe.kill('SIGKILL')
    throw new Error('caffeinate did not exit after parent death')
  }
  const leftover = pmsetAssertions()
  expect(leftover.includes(`pid ${cafePid}(`)).toBe(false)
})
