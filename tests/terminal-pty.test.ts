import { describe, expect, it } from 'bun:test'
import { bunTerminalAvailable, BunPtyBackend, TerminalOutputBuffer } from '../src/terminal/backend.ts'
import { TerminalSessionService } from '../src/terminal/service.ts'

const describePty = bunTerminalAvailable() ? describe : describe.skip
const encode = (value: string) => new TextEncoder().encode(value)
const decode = (value: Uint8Array) => new TextDecoder().decode(value)

describe('terminal output buffering', () => {
  it('delivers ordinary output at microtask latency', async () => {
    const chunks: string[] = []
    const output = new TerminalOutputBuffer((chunk) => chunks.push(decode(chunk)))

    output.write(encode('hel'))
    output.write(encode('lo'))
    expect(chunks).toEqual([])
    await Promise.resolve()
    expect(chunks).toEqual(['hello'])
  })

  it('coalesces fragmented DEC 2026 output into one complete frame', async () => {
    const chunks: string[] = []
    const output = new TerminalOutputBuffer((chunk) => chunks.push(decode(chunk)))

    output.write(encode('\x1b[?20'))
    output.write(encode('26hfirst'))
    output.write(encode('-second'))
    await Promise.resolve()
    expect(chunks).toEqual([])
    output.write(encode('\x1b[?20'))
    output.write(encode('26l'))

    expect(chunks).toEqual(['\x1b[?2026hfirst-second\x1b[?2026l'])
  })

  it('splits adjacent frames that share one transport chunk', async () => {
    const chunks: string[] = []
    const output = new TerminalOutputBuffer((chunk) => chunks.push(decode(chunk)))

    output.write(encode('\x1b[?2026hone\x1b[?2026l\x1b[?2026htwo'))
    await Promise.resolve()
    expect(chunks).toEqual(['\x1b[?2026hone\x1b[?2026l'])
    output.write(encode('\x1b[?2026l'))

    expect(chunks).toEqual([
      '\x1b[?2026hone\x1b[?2026l',
      '\x1b[?2026htwo\x1b[?2026l',
    ])
  })

  it('flushes an abandoned synchronized frame when closed', () => {
    const chunks: string[] = []
    const output = new TerminalOutputBuffer((chunk) => chunks.push(decode(chunk)))

    output.write(encode('\x1b[?2026hpartial'))
    output.close()

    expect(chunks).toEqual(['\x1b[?2026hpartial'])
  })
})

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
