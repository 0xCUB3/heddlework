import * as readline from 'node:readline'
import { discoverPiLiveBridges, PiLiveBridgeTransport, type PiLiveSnapshotRecord } from '../src/pi/live-bridge.ts'
import { boundedInitialHistoryLines, boundedTerminalText, messageText, parseTerminalAttachArguments, selectTerminalAttachBridge, TerminalAttachEventFormatter, terminalAttachListLine } from '../src/pi/terminal-attach.ts'

let options: ReturnType<typeof parseTerminalAttachArguments>
try { options = parseTerminalAttachArguments(process.argv.slice(2)) } catch (error) { fail(errorText(error)) }
if (options.help) {
  console.log('Usage: bun run pi:attach -- [--list | --session <path>]\nAttaches to an existing Pi owner; never starts a second Pi process.')
  process.exit(0)
}

const advertisements = discoverPiLiveBridges()
if (options.list) {
  if (advertisements.length === 0) console.log('No live Pi sessions.')
  else advertisements.forEach((entry) => console.log(terminalAttachListLine(entry)))
  process.exit(0)
}

let selected
try { selected = selectTerminalAttachBridge(advertisements, options.session) } catch (error) { fail(errorText(error)) }
const transport = new PiLiveBridgeTransport({ advertisement: selected.advertisement, includeMessages: true, messageLimit: 40 })

let rl: readline.Interface | undefined
let remoteClosed = false
let inputClosed = false
let snapshot: PiLiveSnapshotRecord | undefined
let hydrated = false
const bufferedEvents: import('../src/pi/types.ts').RpcRecord[] = []
const writeVisible = (text: string) => {
  if (!text) return
  if (!rl || inputClosed || !process.stdout.isTTY) { process.stdout.write(`${text}\n`); return }
  readline.clearLine(process.stdout, 0)
  readline.cursorTo(process.stdout, 0)
  process.stdout.write(`${text}\n`)
  rl.prompt(true)
}
const formatter = new TerminalAttachEventFormatter(writeVisible)
const detachEvent = transport.onEvent((event) => {
  if (!hydrated) {
    bufferedEvents.push(event)
    if (event.type === 'heddlework_live_snapshot') snapshot = event as PiLiveSnapshotRecord
    return
  }
  const sequence = typeof event.sequence === 'number' ? event.sequence : undefined
  if (sequence === undefined || sequence > (snapshot?.sequence ?? -1)) formatter.handle(event)
})
const detachStatus = transport.onStatus((status) => {
  if (status.state === 'exited') {
    remoteClosed = true
    process.exitCode = 1
    writeVisible(`detached: ${boundedTerminalText(status.message)}`)
    rl?.close()
  }
})

try {
  await transport.start()
  writeVisible(`Heddlework terminal attach client · pid ${selected.advertisement.pid}`)
  const live = snapshot
  if (!live) throw new Error('Pi live bridge did not provide its atomic startup snapshot')
  if (live.state?.sessionName) writeVisible(`session: ${boundedTerminalText(String(live.state.sessionName))}`)
  for (const line of boundedInitialHistoryLines(live.messages ?? [])) writeVisible(line)
  if (live.assistant) {
    const text = messageText(live.assistant)
    if (text) writeVisible(`assistant: ${text}`)
  }
  for (const tool of live.tools) formatter.handle(tool)
  hydrated = true
  for (const event of bufferedEvents) {
    if (event === live) continue
    const sequence = typeof event.sequence === 'number' ? event.sequence : undefined
    if (sequence !== undefined && sequence > live.sequence) formatter.handle(event)
  }
  bufferedEvents.length = 0

  if (remoteClosed) throw new Error('Pi live bridge disconnected during attach startup')
  rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: Boolean(process.stdin.isTTY && process.stdout.isTTY), prompt: '> ' })
  rl.once('close', () => { inputClosed = true })
  rl.prompt()
  rl.on('line', (line) => { void handleInput(line).finally(() => { if (rl && !inputClosed) rl.prompt() }) })
  await new Promise<void>((resolve) => rl!.once('close', resolve))
} catch (error) {
  writeVisible(`attach error: ${errorText(error)}`)
  process.exitCode = 1
} finally {
  formatter.dispose()
  detachEvent()
  detachStatus()
  await transport.stop().catch(() => undefined)
}

async function handleInput(raw: string): Promise<void> {
  const line = raw.trim()
  if (!line) return
  if (line === '/detach' || line === '/quit') { rl?.close(); return }
  if (line === '/abort') { await command({ type: 'abort' }); return }
  if (line === '/help') { writeVisible('Commands: /abort, /name <name>, /thinking <level>, /detach'); return }
  if (line.startsWith('/name ')) { await command({ type: 'set_session_name', name: line.slice(6).trim() }); return }
  if (line.startsWith('/thinking ')) { await command({ type: 'set_thinking_level', level: line.slice(10).trim() }); return }
  await command({ type: 'prompt', message: raw })
}

async function command(value: Record<string, unknown>): Promise<void> {
  try { await transport.request(value as { type: string }) } catch (error) { writeVisible(`command error: ${errorText(error)}`) }
}

function fail(message: string): never {
  console.error(`heddlework pi:attach: ${boundedTerminalText(message)}`)
  process.exit(1)
}

function errorText(error: unknown): string {
  return boundedTerminalText(error instanceof Error ? error.message : String(error))
}
