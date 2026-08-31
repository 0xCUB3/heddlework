import { describe, expect, it } from 'bun:test'
import { bunTerminalAvailable, BunPtyBackend } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'

const describePty = bunTerminalAvailable() ? describe : describe.skip

describePty('Bun.Terminal PTY', () => {
  it('runs a login-free shell command through the session service', async () => {
    const service = new TerminalSessionService({
      cwd: process.cwd(),
      backend: new BunPtyBackend(),
    })
    const id = await service.spawn({
      cols: 40,
      rows: 10,
      shell: '/bin/sh',
      args: ['-c', 'printf hello-pty; exit 0'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color' },
    })
    const started = Date.now()
    while (Date.now() - started < 2000) {
      const grid = service.grid(id)
      if (grid?.viewport.some((row) => row.text.includes('hello-pty'))) break
      await Bun.sleep(20)
    }
    expect(service.grid(id)?.viewport.some((row) => row.text.includes('hello-pty'))).toBe(true)
    await service.dispose()
  }, 8_000)

  const itUnix = process.platform === 'win32' ? it.skip : it
  itUnix('resizes a foreground TUI process group', async () => {
    const pty = await new BunPtyBackend().spawn({
      cwd: process.cwd(),
      cols: 40,
      rows: 10,
      shell: '/bin/bash',
      args: ['--noprofile', '--norc', '-i'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TERM: 'xterm-256color', LC_ALL: 'C' },
    })
    let output = ''
    const stop = pty.onData((chunk) => { output += new TextDecoder().decode(chunk) })
    try {
      await Bun.sleep(100)
      pty.write("/bin/sh -c 'trap \"echo RESIZED:\\$(stty size)\" WINCH; echo READY; while :; do sleep .1; done'\n")
      const readyAt = Date.now()
      while (!output.includes('READY') && Date.now() - readyAt < 2_000) await Bun.sleep(20)
      expect(output).toContain('READY')

      pty.resize(100, 30)
      const resizedAt = Date.now()
      while (!output.includes('RESIZED:30 100') && Date.now() - resizedAt < 2_000) await Bun.sleep(20)
      expect(output).toContain('RESIZED:30 100')
    } finally {
      stop()
      pty.kill()
    }
  }, 8_000)
})
