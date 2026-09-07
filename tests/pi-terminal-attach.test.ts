import { afterEach, describe, expect, test } from 'bun:test'
import { createServer } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { boundedInitialHistory, boundedInitialHistoryLines, boundedTerminalText, messageText, normalizeSessionPath, parseTerminalAttachArguments, sanitizeTerminalText, selectTerminalAttachBridge, TerminalAttachEventFormatter, terminalAttachListLine, TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT } from '../src/pi/terminal-attach.ts'
import type { PiLiveBridgeAdvertisement } from '../src/pi/live-bridge.ts'

const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

function advertisement(path: string | undefined, pid: number): PiLiveBridgeAdvertisement {
  return { version: 1, pid, port: 1000 + pid, token: 'secret', mode: 'tui', cwd: '/tmp/project', sessionId: `s-${pid}`, ...(path ? { sessionFile: path } : {}), updatedAt: pid }
}

describe('Pi terminal attach client', () => {
  test('rejects malformed selectors rather than attaching to an unintended sole session', () => {
    expect(parseTerminalAttachArguments(['--', '--session', 'a file.jsonl'])).toEqual({ list: false, help: false, session: 'a file.jsonl' })
    expect(parseTerminalAttachArguments(['--help']).help).toBe(true)
    expect(() => parseTerminalAttachArguments(['--sesion', 'file'])).toThrow('Unknown argument')
    expect(() => parseTerminalAttachArguments(['--session'])).toThrow('requires a path')
    expect(() => parseTerminalAttachArguments(['--session', '--list'])).toThrow('requires a path')
    expect(() => parseTerminalAttachArguments(['--list', '--session', 'file'])).toThrow('not both')
  })
  test('selects by normalized session path and fails ambiguity/unavailability', () => {
    const path = join('/tmp', 'sessions', '..', 'live.jsonl')
    const one = advertisement('/tmp/live.jsonl', 1)
    expect(selectTerminalAttachBridge([one], path).advertisement).toBe(one)
    expect(normalizeSessionPath(path)).toBe('/tmp/live.jsonl')
    expect(() => selectTerminalAttachBridge([], path)).toThrow('No live Pi sessions')
    expect(() => selectTerminalAttachBridge([one], '/tmp/missing.jsonl')).toThrow('No live Pi session matches')
    expect(() => selectTerminalAttachBridge([one, advertisement('/tmp/other.jsonl', 2)])).toThrow('Multiple live Pi sessions')
    expect(() => selectTerminalAttachBridge([one, advertisement('/tmp/live.jsonl', 2)], '/tmp/live.jsonl')).toThrow('Multiple live Pi sessions match')
  })

  test('lists live process identity without exposing token and bounds history', () => {
    const live = { ...advertisement('/tmp/live.jsonl', 7), sessionName: 'work', token: 'do-not-print' }
    expect(terminalAttachListLine(live)).toContain('/tmp/live.jsonl · pid 7')
    expect(terminalAttachListLine(live)).not.toContain('do-not-print')
    expect(boundedInitialHistory(Array.from({ length: 80 }, (_, index) => index))).toEqual(Array.from({ length: 40 }, (_, index) => index + 40))
    expect(boundedInitialHistory([1, 2, 3], 0)).toEqual([])
    const lines = boundedInitialHistoryLines([{ role: 'toolResult', content: 'x'.repeat(100) }, { role: 'user', content: 'tail' }], 40, 24)
    expect(lines.join('').length).toBeLessThanOrEqual(24)
    expect(lines.at(-1)).toBe('user: tail')
    expect(boundedTerminalText('x'.repeat(100), 8)).toBe('xxxxxxx…')
    expect(boundedInitialHistory([1, 2, 3], 0.5)).toEqual([])
    const huge = boundedInitialHistoryLines([{ role: 'assistant', content: 'x'.repeat(100_000) }])
    expect(huge[0]!.length).toBeLessThanOrEqual(TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT + 'assistant: '.length)
  })

  test('strips terminal control injection', () => {
    expect(sanitizeTerminalText('safe\x1b[2J\x1b]0;owned\x07\r text\x00\x85')).toBe('safe text')
    expect(terminalAttachListLine({ ...advertisement('/tmp/live\x1b[2J.jsonl', 9), cwd: '/tmp\r/evil' })).not.toContain('\x1b')
    expect(messageText({ content: 'function f() {\n\treturn 1;\n}\x1b[2J' })).toBe('function f() {\n\treturn 1;\n}')
    expect(terminalAttachListLine({ ...advertisement('/tmp/live.jsonl', 9), sessionName: 'line1\nline2' })).not.toContain('\n')
  })

  test('coalesces streamed assistant deltas and prints user/tool events', async () => {
    const output: string[] = []
    const formatter = new TerminalAttachEventFormatter((line) => output.push(line), 10)
    formatter.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hel' } })
    formatter.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'lo' } })
    expect(output).toEqual([])
    await Bun.sleep(15)
    formatter.handle({ type: 'message_start', message: { role: 'user', content: 'next' } })
    formatter.handle({ type: 'tool_execution_start', toolName: 'read\x1b[2J' })
    formatter.dispose()
    expect(output).toEqual(['assistant: hello', 'user: next', 'tool: read'])
  })

  test('renders the latest in-progress tool snapshot once per update tick', () => {
    const output: string[] = []
    const formatter = new TerminalAttachEventFormatter((line) => output.push(line))
    formatter.handle({ type: 'tool_execution_update', toolCallId: 'read-1', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'first' }] } })
    formatter.handle({ type: 'tool_execution_update', toolCallId: 'read-1', toolName: 'read', partialResult: { content: [{ type: 'text', text: 'latest\noutput' }] } })
    expect(output).toEqual([])
    formatter.flush()
    expect(output).toEqual(['tool: read (running)\nlatest\noutput'])
    formatter.dispose()
  })

  test('does not lose oversized assistant deltas or reorder tool results before buffered text', () => {
    const output: string[] = []
    const formatter = new TerminalAttachEventFormatter((line) => output.push(line))
    const text = 'x'.repeat(TERMINAL_ATTACH_MESSAGE_CHAR_LIMIT * 2 + 10)
    formatter.handle({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
    formatter.handle({ type: 'tool_execution_end', toolCallId: 'read-1', result: { content: [{ type: 'text', text: 'done' }] } })
    formatter.dispose()
    expect(output.at(-1)).toBe('tool result: done')
    expect(output.slice(0, -1).map((line) => line.slice('assistant: '.length)).join('')).toBe(text)
  })

  test('CLI attaches to the advertised owner, sends prompts, and prints live events', async () => {
    const root = mkdtempSync(join(tmpdir(), 'heddlework-pi-attach-'))
    temporary.push(root)
    const registry = join(root, 'pi-live')
    await Bun.write(join(registry, '.keep'), '')
    const token = 'attach-integration-token'
    const commands: string[] = []
    const server = createServer((socket) => {
      let authenticated = false
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString()
        while (true) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const record = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>
          buffer = buffer.slice(newline + 1)
          if (!authenticated) {
            expect(record).toEqual({ type: 'hello', token, version: 1 })
            authenticated = true
            continue
          }
          commands.push(String(record.type))
          const respond = (data?: unknown) => socket.write(`${JSON.stringify({ type: 'response', id: record.id, command: record.type, success: true, ...(data === undefined ? {} : { data }) })}\n`)
          if (record.type === 'get_live_state') {
            expect(record.includeMessages).toBe(true)
            expect(record.messageLimit).toBe(40)
            respond({
              state: { sessionId: 'same-owner', sessionFile, sessionName: 'Attached', isStreaming: true },
              cwd: root,
              messages: [{ role: 'user', content: 'history' }],
              assistant: { role: 'assistant', content: [{ type: 'text', text: 'in flight' }] },
              tools: [],
              sequence: 10,
            })
            socket.write(`${JSON.stringify({ type: 'message_update', sequence: 9, assistantMessageEvent: { type: 'text_delta', delta: 'stale' } })}\n`)
            socket.write(`${JSON.stringify({ type: 'message_update', sequence: 11, assistantMessageEvent: { type: 'text_delta', delta: 'after snapshot' } })}\n`)
            socket.write(`${JSON.stringify({ type: 'message_end', sequence: 12 })}\n`)
          }
          else if (record.type === 'prompt') {
            expect(record.message).toBe('hello owner')
            respond()
            socket.write(`${JSON.stringify({ type: 'message_start', sequence: 13, message: { role: 'user', content: 'hello owner' } })}\n`)
            socket.write(`${JSON.stringify({ type: 'message_update', sequence: 14, assistantMessageEvent: { type: 'text_delta', delta: 'live reply' } })}\n`)
            socket.write(`${JSON.stringify({ type: 'message_end', sequence: 15 })}\n`)
          }
        }
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected TCP address')
    const sessionFile = join(root, 'session.jsonl')
    writeFileSync(join(registry, `${process.pid}.json`), JSON.stringify({
      version: 1, pid: process.pid, port: address.port, token, mode: 'tui', cwd: root,
      sessionFile, sessionId: 'same-owner', updatedAt: Date.now(),
    } satisfies PiLiveBridgeAdvertisement))
    const bun = process.execPath
    const child = Bun.spawn([bun, join(import.meta.dir, '..', 'scripts', 'pi-attach.ts'), '--session', sessionFile], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, HEDDLEWORK_RUNTIME_DIR: root },
      stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
    })
    child.stdin.write('hello owner\n')
    await Bun.sleep(80)
    child.stdin.write('/detach\n')
    child.stdin.end()
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (exitCode !== 0) throw new Error(`attach CLI exited ${exitCode}\nstdout=${stdout}\nstderr=${stderr}`)
    expect(stderr).toBe('')
    expect(stdout).toContain('Heddlework terminal attach client')
    expect(stdout).toContain('user: history')
    expect(stdout).toContain('assistant: in flight')
    expect(stdout).toContain('assistant: after snapshot')
    expect(stdout).not.toContain('stale')
    expect(stdout).toContain('user: hello owner')
    expect(stdout).toContain('assistant: live reply')
    expect(commands).toEqual(expect.arrayContaining(['get_live_state', 'prompt']))
    expect(commands).not.toContain('get_state')
    expect(commands).not.toContain('get_messages')
    expect(commands).toContain('prompt')
  }, 5_000)
})
